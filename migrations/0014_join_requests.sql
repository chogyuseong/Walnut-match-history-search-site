-- 참가 신청 링크(2026-11-06). 운영자가 링크를 뿌리면 참가자가 로그인 없이 "오늘 참가"를 누른다.
-- 그날그날 쓰는 임시 자료라 백업 파일에는 넣지 않는다.

-- 모임당 신청 링크 1개. 토큰 원문이 아니라 해시만 저장한다(공동 운영자 초대·운영자 넘기기와 같은 관례).
-- 다시 만들면 해시를 바꿔 이전 링크는 바로 열리지 않는다. 백업 복원은 이 행을 바꾸지 않는다(조회 토큰과 같다).
-- 모임 삭제 때 함께 지운다(src/server/deletion.ts의 GROUP_TABLES).
CREATE TABLE join_links (
  group_id TEXT PRIMARY KEY REFERENCES groups (id),
  token_hash TEXT NOT NULL UNIQUE,
  is_open INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 신청 한 줄: 기존 참가자(participant_id) 또는 명단에 없는 새 이름(new_name) 중 하나.
-- 새 이름 신청은 참가자를 만들지 않는다(운영자가 경기를 시작할 때 기존 흐름대로 생긴다).
-- 복합 외래 키로 다른 모임의 참가자를 연결할 수 없다. 참가자 표를 참조하므로 백업 복원·모임 삭제가
-- 지우는 공통 표 목록(GROUP_DATA_TABLES)의 맨 앞에 둔다(복원하면 신청 목록은 비워진다).
-- 합쳐진 사람의 신청은 행을 옮기지 않고 보여줄 때 남은 사람 것으로 본다(중복이면 하나로).
CREATE TABLE join_requests (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  participant_id TEXT,
  new_name TEXT,
  name_key TEXT,
  created_at TEXT NOT NULL,
  CHECK ((participant_id IS NULL) <> (new_name IS NULL)),
  CHECK ((new_name IS NULL) = (name_key IS NULL)),
  FOREIGN KEY (group_id, participant_id) REFERENCES participants (group_id, id)
);
-- 같은 사람·같은 새 이름은 한 번만.
CREATE UNIQUE INDEX uq_join_requests_participant
  ON join_requests (group_id, participant_id) WHERE participant_id IS NOT NULL;
CREATE UNIQUE INDEX uq_join_requests_name
  ON join_requests (group_id, name_key) WHERE name_key IS NOT NULL;
CREATE INDEX idx_join_requests_group ON join_requests (group_id, created_at);
