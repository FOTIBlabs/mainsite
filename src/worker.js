// FOTIB Labs — AI 협업 시스템 API
//
// 정적 사이트(index.html 등)는 그대로 서빙하고, /api/collab/* 요청만 이 워커가 처리합니다.
// wrangler.json의 "main"이 이 파일을 가리키고, assets.binding("ASSETS")으로
// 나머지 모든 요청을 기존 정적 자산으로 그대로 넘깁니다.
//
// 인증: 쓰기(POST/PATCH) 요청은 `Authorization: Bearer <COLLAB_TOKEN>` 헤더가 필요합니다.
// COLLAB_TOKEN은 코드에 없고 Cloudflare 대시보드의 Worker Bindings(Secrets Store 또는 plain Secret)로만 존재합니다.
// 읽기(GET)는 공개 — 사이트 방문자도 진행 상황을 볼 수 있게 (필요하면 나중에 잠글 수 있음).

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
};

const PHASES = new Set(["flow", "observe", "tune", "iterate", "balance"]);
const STATUSES = new Set(["active", "paused", "done"]);
const KINDS = new Set(["message", "command", "decision", "blocker", "done"]);

function json(data, init) {
  init = init || {};
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: Object.assign({}, JSON_HEADERS, CORS_HEADERS, init.headers || {}),
  });
}

// COLLAB_TOKEN 바인딩은 두 가지 형태로 올 수 있음:
//  - Secrets Store 바인딩(2026-09-14부터 이 계정에서 쓰는 방식): env.COLLAB_TOKEN이 객체이고
//    실제 값은 비동기 env.COLLAB_TOKEN.get()으로만 꺼낼 수 있음(문자열이 바로 들어있지 않음).
//  - 예전 방식의 plain text/Secret 환경변수: env.COLLAB_TOKEN이 바로 문자열.
// 2026-09-14 ④ 근본 원인: 애초에 COLLAB_TOKEN이 이 Worker의 Bindings에 전혀 연결돼 있지 않았음
// (Settings→Builds의 "Variables and secrets"는 빌드 파이프라인 전용이라 런타임 env에 안 들어감).
// 어느 쪽으로 바인딩해도 동작하도록 둘 다 지원.
async function resolveSecretValue(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v.get === "function") {
    try { return (await v.get()) || ""; } catch (e) { return ""; }
  }
  return "";
}

async function isAuthed(request, env) {
  const auth = request.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";
  // env.COLLAB_TOKEN 쪽도 trim — Cloudflare 대시보드에 값을 붙여넣을 때
  // 터미널 출력의 개행문자가 같이 복사되는 경우가 흔해서, 저장된 시크릿 끝에
  // 보이지 않는 공백/개행이 남아있으면 아무리 정확히 복사해도 영원히 불일치함.
  const stored = String(await resolveSecretValue(env.COLLAB_TOKEN)).trim();
  return !!stored && token === stored;
}

function slugify(input) {
  const s = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\-\s]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 64);
  return s || "project";
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (e) {
    return {};
  }
}

async function handleApi(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const parts = url.pathname.split("/").filter(Boolean); // ['api','collab','projects', ...]

  // GET /api/collab/whoami — 토큰이 유효한지만 확인. DB 접근 없음, 아무 데이터도 바꾸지 않음.
  // 사이트 UI가 토큰을 저장하기 전에 "이 토큰이 맞는지"를 즉시 확인하는 용도.
  if (parts[2] === "whoami") {
    if (request.method !== "GET") return json({ error: "method not allowed" }, { status: 405 });
    if (!(await isAuthed(request, env))) return json({ ok: false }, { status: 401 });
    return json({ ok: true });
  }

  if (parts[2] !== "projects") {
    return json({ error: "not found" }, { status: 404 });
  }
  const seg = parts.slice(3); // 'projects' 다음 부분: [] | [id] | [id,'messages']

  // GET /api/collab/projects
  if (seg.length === 0 && request.method === "GET") {
    const { results } = await env.COLLAB_DB.prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM messages m WHERE m.project_id = p.id) AS message_count,
              (SELECT content FROM messages m WHERE m.project_id = p.id ORDER BY m.id DESC LIMIT 1) AS last_message,
              (SELECT sender_label FROM messages m WHERE m.project_id = p.id ORDER BY m.id DESC LIMIT 1) AS last_sender
       FROM projects p ORDER BY p.updated_at DESC`
    ).all();
    return json({ projects: results });
  }

  // POST /api/collab/projects  { id?, name, phase? }
  if (seg.length === 0 && request.method === "POST") {
    if (!(await isAuthed(request, env))) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "name required" }, { status: 400 });
    const id = slugify(body.id || name);
    const phase = PHASES.has(body.phase) ? body.phase : "flow";
    const now = new Date().toISOString();
    await env.COLLAB_DB.prepare(
      `INSERT INTO projects (id, name, phase, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'active', ?4, ?4)
       ON CONFLICT(id) DO UPDATE SET name=?2, updated_at=?4`
    ).bind(id, name, phase, now).run();
    return json({ id, name, phase }, { status: 201 });
  }

  if (seg.length === 0) return json({ error: "method not allowed" }, { status: 405 });

  const projectId = decodeURIComponent(seg[0]);

  // PATCH /api/collab/projects/:id  { phase?, status?, current_turn?, name? }
  if (seg.length === 1 && request.method === "PATCH") {
    if (!(await isAuthed(request, env))) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJson(request);
    const fields = [];
    const values = [];
    if (body.phase !== undefined && PHASES.has(body.phase)) { fields.push("phase=?"); values.push(body.phase); }
    if (body.status !== undefined && STATUSES.has(body.status)) { fields.push("status=?"); values.push(body.status); }
    if (body.current_turn !== undefined) { fields.push("current_turn=?"); values.push(body.current_turn || null); }
    if (body.name !== undefined && String(body.name).trim()) { fields.push("name=?"); values.push(String(body.name).trim()); }
    if (!fields.length) return json({ error: "no valid fields" }, { status: 400 });
    fields.push("updated_at=?");
    values.push(new Date().toISOString());
    values.push(projectId);
    const res = await env.COLLAB_DB.prepare(
      `UPDATE projects SET ${fields.join(", ")} WHERE id=?`
    ).bind(...values).run();
    if (!res.meta || !res.meta.rows_written) return json({ error: "not found" }, { status: 404 });
    return json({ ok: true });
  }

  // DELETE /api/collab/projects/:id — 프로젝트와 그 안의 메시지를 전부 삭제.
  // 관리자 토큰 권한: 프로젝트는 누가 만들었든 전부 삭제 가능(AI가 자동 생성한 방 포함).
  if (seg.length === 1 && request.method === "DELETE") {
    if (!(await isAuthed(request, env))) return json({ error: "unauthorized" }, { status: 401 });
    await env.COLLAB_DB.prepare(`DELETE FROM messages WHERE project_id=?1`).bind(projectId).run();
    const res = await env.COLLAB_DB.prepare(`DELETE FROM projects WHERE id=?1`).bind(projectId).run();
    if (!res.meta || !res.meta.rows_written) return json({ error: "not found" }, { status: 404 });
    return json({ ok: true });
  }

  // GET /api/collab/projects/:id/messages?after=0&limit=200
  if (seg.length === 2 && seg[1] === "messages" && request.method === "GET") {
    const after = Number(url.searchParams.get("after") || 0) || 0;
    const limit = Math.min(Number(url.searchParams.get("limit") || 200) || 200, 500);
    const { results } = await env.COLLAB_DB.prepare(
      `SELECT id, project_id, sender, sender_label, kind, content, created_at
       FROM messages WHERE project_id=?1 AND id > ?2 ORDER BY id ASC LIMIT ?3`
    ).bind(projectId, after, limit).all();
    return json({ messages: results });
  }

  // POST /api/collab/projects/:id/messages  { sender, sender_label?, kind?, content }
  if (seg.length === 2 && seg[1] === "messages" && request.method === "POST") {
    if (!(await isAuthed(request, env))) return json({ error: "unauthorized" }, { status: 401 });
    const body = await readJson(request);
    const sender = String(body.sender || "").trim();
    const content = String(body.content || "").trim();
    if (!sender || !content) return json({ error: "sender and content required" }, { status: 400 });
    const kind = KINDS.has(body.kind) ? body.kind : "message";
    const now = new Date().toISOString();

    // 프로젝트가 아직 없으면 자동 생성 — 에이전트가 새 프로젝트 방에 바로 첫 메시지를 남길 수 있게
    await env.COLLAB_DB.prepare(
      `INSERT INTO projects (id, name, phase, status, created_at, updated_at)
       VALUES (?1, ?1, 'flow', 'active', ?2, ?2)
       ON CONFLICT(id) DO UPDATE SET updated_at=?2`
    ).bind(projectId, now).run();

    const ins = await env.COLLAB_DB.prepare(
      `INSERT INTO messages (project_id, sender, sender_label, kind, content, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(projectId, sender, body.sender_label || null, kind, content, now).run();

    return json({ id: ins.meta.last_row_id, created_at: now }, { status: 201 });
  }

  // PATCH /api/collab/projects/:id/messages/:msgId  { content }
  // 관리자 토큰 권한: "관리자(user)가 보낸 메시지"만 내용 수정 가능 — AI 에이전트가 보낸 메시지는 수정 불가(기록 보존 목적).
  if (seg.length === 3 && seg[1] === "messages" && request.method === "PATCH") {
    if (!(await isAuthed(request, env))) return json({ error: "unauthorized" }, { status: 401 });
    const msgId = Number(seg[2]);
    if (!msgId) return json({ error: "invalid message id" }, { status: 400 });
    const existing = await env.COLLAB_DB.prepare(
      `SELECT sender FROM messages WHERE id=?1 AND project_id=?2`
    ).bind(msgId, projectId).first();
    if (!existing) return json({ error: "not found" }, { status: 404 });
    if (existing.sender !== "user") {
      return json({ error: "admin이 보낸 메시지만 수정할 수 있습니다" }, { status: 403 });
    }
    const body = await readJson(request);
    const content = String(body.content || "").trim();
    if (!content) return json({ error: "content required" }, { status: 400 });
    await env.COLLAB_DB.prepare(
      `UPDATE messages SET content=?1 WHERE id=?2`
    ).bind(content, msgId).run();
    return json({ ok: true, content });
  }

  // DELETE /api/collab/projects/:id/messages/:msgId
  // 관리자 토큰 권한: 보낸 사람 상관없이(AI가 작성한 메시지 포함) 전부 삭제 가능.
  if (seg.length === 3 && seg[1] === "messages" && request.method === "DELETE") {
    if (!(await isAuthed(request, env))) return json({ error: "unauthorized" }, { status: 401 });
    const msgId = Number(seg[2]);
    if (!msgId) return json({ error: "invalid message id" }, { status: 400 });
    const res = await env.COLLAB_DB.prepare(
      `DELETE FROM messages WHERE id=?1 AND project_id=?2`
    ).bind(msgId, projectId).run();
    if (!res.meta || !res.meta.rows_written) return json({ error: "not found" }, { status: 404 });
    return json({ ok: true });
  }

  return json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/collab")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: "server error", detail: String((err && err.message) || err) }, { status: 500 });
      }
    }
    // 그 외 모든 요청은 기존 정적 사이트 그대로
    return env.ASSETS.fetch(request);
  },
};
