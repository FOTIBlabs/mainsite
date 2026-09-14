-- FOTIB Labs — AI 협업 시스템 D1 스키마
-- 최초 1회만 실행하면 됩니다.
--   방법 A) Cloudflare 대시보드 → Workers & Pages → D1 → (만든 데이터베이스) → Console 탭에 이 파일 내용을 그대로 붙여넣고 실행
--   방법 B) 로컬에 wrangler가 있다면: wrangler d1 execute fotib-collab --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,          -- 슬러그, 예: 'macropad-build'
  name         TEXT NOT NULL,             -- 사람이 보는 이름, 예: '매크로패드 자작'
  phase        TEXT NOT NULL DEFAULT 'flow',   -- flow|observe|tune|iterate|balance (FOTIB 루프 단계 재사용)
  status       TEXT NOT NULL DEFAULT 'active', -- active|paused|done
  current_turn TEXT,                       -- 지금 차례인 에이전트 이름 (컨트롤러가 갱신, 지금은 비워둬도 됨)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  sender        TEXT NOT NULL,            -- 'user' 또는 에이전트 식별자('claude','gpt' 등 자유 문자열)
  sender_label  TEXT,                     -- 화면에 보여줄 표시 이름 (없으면 sender 그대로 표시)
  kind          TEXT NOT NULL DEFAULT 'message', -- message|command|decision|blocker|done
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, id);

-- 데모/시작용 프로젝트 하나 — 이 시스템을 만드는 과정 자체를 첫 방으로 기록해둠
INSERT OR IGNORE INTO projects (id, name, phase, status, created_at, updated_at)
VALUES ('collab-system', 'AI 협업 시스템 구축', 'tune', 'active', datetime('now'), datetime('now'));

INSERT INTO messages (project_id, sender, sender_label, kind, content, created_at)
SELECT 'collab-system', 'user', 'Lee', 'command',
       '이 방부터 시작. 여기서 오가는 대화가 곧 이 시스템을 만드는 과정입니다.',
       datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM messages WHERE project_id = 'collab-system');
