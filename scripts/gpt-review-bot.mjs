#!/usr/bin/env node
/**
 * GPT 감독/검수 봇
 * ------------------------------------------------------------
 * FOTIB AI 협업 시스템(fotiblabs.com, /api/collab/*)을 주기적으로 폴링해서
 * current_turn === 'gpt' 인 프로젝트를 찾아 최근 작업 내역을 OpenAI API로
 * 검수(승인/반려)하고, 그 결과를 다시 사이트에 기록하는 스크립트.
 *
 * 실행 방식: GitHub Actions 스케줄 워크플로(.github/workflows/gpt-review-bot.yml)에서
 * `node scripts/gpt-review-bot.mjs` 로 주기 실행됨. Node 18+ (전역 fetch) 필요.
 *
 * 상태 저장 없이(stateless) 매 실행마다 사이트 API에서 프로젝트/메시지 목록을 읽어
 * 판단하도록 설계했다. 즉, 별도 DB/파일 없이 current_turn 값과 메시지 kind만으로
 * "지금 누구 차례인지", "몇 번 반려됐는지"를 계산한다.
 * ------------------------------------------------------------
 */

const {
  COLLAB_API_BASE = 'https://fotiblabs.com',
  COLLAB_TOKEN,
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  MAX_RETRIES = '3',
  GPT_SENDER = 'gpt',
  GPT_SENDER_LABEL = 'GPT 감독관',
  CLAUDE_SENDER = 'claude',
} = process.env;

const maxRetries = parseInt(MAX_RETRIES, 10) || 3;

if (!COLLAB_TOKEN) {
  console.error('환경변수 COLLAB_TOKEN이 설정되지 않았습니다.');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('환경변수 OPENAI_API_KEY가 설정되지 않았습니다.');
  process.exit(1);
}

// ---------- 사이트 API 헬퍼 ----------

async function collabFetch(path, opts = {}) {
  const res = await fetch(`${COLLAB_API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${COLLAB_TOKEN}`,
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${opts.method || 'GET'} ${path} 실패: ${res.status} ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function getActiveProjectsForReview() {
  const { projects } = await collabFetch('/api/collab/projects');
  return projects.filter((p) => p.status === 'active' && p.current_turn === GPT_SENDER);
}

async function getAllMessages(projectId) {
  // limit=500(최대값)으로 전체를 가져온 뒤 오래된순으로 정렬해서 쓴다.
  // (API가 최신순/오래된순 중 어느 쪽 기본 정렬인지 문서만으로 확정할 수 없어서,
  //  받은 뒤 created_at 기준으로 직접 정렬해 안전하게 처리한다.)
  const { messages } = await collabFetch(`/api/collab/projects/${projectId}/messages?limit=500`);
  return [...messages].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

async function postMessage(projectId, kind, content) {
  return collabFetch(`/api/collab/projects/${projectId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ sender: GPT_SENDER, sender_label: GPT_SENDER_LABEL, kind, content }),
  });
}

async function patchProject(projectId, fields) {
  return collabFetch(`/api/collab/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

// ---------- 판단 로직 ----------

/**
 * 마지막 'decision'(승인/반려 확정) 또는 사용자(sender==='user')의 개입 이후
 * gpt가 보낸 'command'(재작업 요청) 개수를 센다.
 * → 사용자가 한 번이라도 개입하면 카운트가 리셋되므로, blocker로 멈춘 뒤
 *   사용자가 메시지를 남기고 status를 다시 active로 바꾸면 정상적으로 재개된다.
 */
function countRetriesSinceLastCheckpoint(messages) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.kind === 'decision' || m.sender === 'user') break;
    if (m.kind === 'command' && m.sender === GPT_SENDER) count++;
  }
  return count;
}

function buildTranscript(messages, limit = 20) {
  return messages
    .slice(-limit)
    .map((m) => `[${m.created_at}] ${m.sender_label || m.sender} (${m.kind}): ${m.content}`)
    .join('\n');
}

async function reviewWithGPT(project, transcript) {
  const systemPrompt = `당신은 여러 AI 에이전트가 협업하는 프로젝트의 감독관입니다.
아래는 "${project.name}" 프로젝트 최근 대화 기록입니다. 가장 최근에 작업자(클로드)가 제출한
작업 결과를 검토해서 다음 중 하나로 판단하세요.

- "approve": 요청된 작업을 충분히 만족한다
- "revise": 부족하거나 수정이 필요하다 (feedback에 구체적인 이유와 무엇을 고쳐야 하는지 반드시 포함)

이 작업 전체(프로젝트의 현재 단계)가 완전히 끝났다고 판단되면 task_complete를 true로 표시하세요.
애매하면 approve보다 revise 쪽으로 보수적으로 판단하세요.

반드시 아래 JSON 형식으로만 답하세요 (다른 텍스트 금지):
{"decision": "approve" 또는 "revise", "feedback": "한국어로 구체적인 근거/피드백", "task_complete": true 또는 false}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: transcript || '(대화 기록 없음)' },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI API 실패: ${res.status} ${text}`);
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`GPT 응답 JSON 파싱 실패: ${raw}`);
  }
}

// ---------- 프로젝트 1건 처리 ----------

async function handleProject(project) {
  console.log(`[${project.id}] 검수 시작`);
  const messages = await getAllMessages(project.id);
  const retryCount = countRetriesSinceLastCheckpoint(messages);

  if (retryCount >= maxRetries) {
    console.log(`[${project.id}] 재시도 상한(${maxRetries}회) 초과 — 사용자 개입 필요, 일시정지`);
    await postMessage(
      project.id,
      'blocker',
      `⚠️ 반려가 ${retryCount}회 반복되어 자동 재작업을 중단합니다. 내용을 확인하고 메시지를 남긴 뒤, ` +
        `프로젝트 상태를 다시 active로 바꿔주세요.`
    );
    await patchProject(project.id, { status: 'paused' });
    return;
  }

  const transcript = buildTranscript(messages);
  const { decision, feedback, task_complete } = await reviewWithGPT(project, transcript);

  if (decision === 'approve') {
    await postMessage(project.id, 'decision', `✅ 승인: ${feedback || ''}`.trim());
    if (task_complete) {
      await patchProject(project.id, { status: 'done' });
      console.log(`[${project.id}] 승인 + 전체 작업 완료 처리`);
    } else {
      await patchProject(project.id, { current_turn: CLAUDE_SENDER });
      console.log(`[${project.id}] 승인 — 클로드에게 턴 이관`);
    }
  } else {
    await postMessage(
      project.id,
      'command',
      `🔁 재작업 요청 (${retryCount + 1}/${maxRetries}번째): ${feedback || ''}`.trim()
    );
    await patchProject(project.id, { current_turn: CLAUDE_SENDER });
    console.log(`[${project.id}] 반려 — 재작업 요청, 클로드에게 턴 이관`);
  }
}

// ---------- 진입점 ----------

async function main() {
  const projects = await getActiveProjectsForReview();
  console.log(`검수 대상(current_turn=${GPT_SENDER}, status=active) 프로젝트 ${projects.length}건`);

  for (const project of projects) {
    try {
      await handleProject(project);
    } catch (err) {
      console.error(`[${project.id}] 처리 중 오류:`, err.message);
      try {
        await postMessage(project.id, 'blocker', `⚠️ 검수 스크립트 오류: ${err.message}`);
      } catch (_) {
        // 로그 남기기 자체가 실패하면 콘솔 로그만 남기고 넘어간다
      }
    }
  }
}

main().catch((err) => {
  console.error('실행 실패:', err);
  process.exit(1);
});
