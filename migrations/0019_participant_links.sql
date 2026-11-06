-- 참가자 본인 연결 · 멤버 기능 · 요청(2026-11-06). 원칙: 참가자는 자기 것만 건드리고, 기록은 운영자만 고친다.
-- 세 표 모두 계정·운영 자료라 백업 파일에 넣지 않는다(GROUP_DATA_TABLES에 넣지 않음).
-- 참가자·경기 쪽에는 외래 키를 걸지 않는다: 같은 모임 복원이 참가자·경기 행을 지웠다 다시 넣기 때문이다.
-- 대신 복원이 끝날 때 없어진 참가자·경기를 가리키는 행을 지운다(src/server/restore.ts). 모임 삭제는 함께 지운다
-- (src/server/deletion.ts GROUP_TABLES). 다른 모임 참가자와 묶이지 않는 것은 서버가 만들 때 확인한다.

-- 계정 ↔ 참가자 연결. 한 참가자에는 계정 하나(기본 키), 한 계정은 한 모임에서 참가자 하나(고유 색인).
-- avoid_self_at: 멤버가 직접 기피 라인을 정한 시각. 운영자가 기피 라인을 고치면 NULL로 돌린다("본인이 정함" 표시).
CREATE TABLE participant_links (
  group_id TEXT NOT NULL REFERENCES groups (id),
  participant_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  created_at TEXT NOT NULL,
  avoid_self_at TEXT,
  PRIMARY KEY (group_id, participant_id)
);
CREATE UNIQUE INDEX uq_participant_links_account ON participant_links (group_id, account_id);
CREATE INDEX idx_participant_links_account ON participant_links (account_id);

-- 연결 링크(참가자별). 공동 운영자 초대와 같은 방식: 1회용, 24시간, 토큰은 해시만, 다시 만들면 쓰지 않은 이전 링크는 지운다.
CREATE TABLE participant_claims (
  token_hash TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  participant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_participant_claims_person ON participant_claims (group_id, participant_id);

-- 멤버가 남기는 요청. 기록은 바뀌지 않고 운영자가 처리한다.
-- kind: correction = 경기 결과 정정 요청(자기가 뛴 경기, match_id 필수), erase = 내 기록 삭제·익명 처리 요청.
-- body: 요청 글(최대 200자, 화면은 글자로만 그린다). reply: 운영자의 짧은 답(선택, 최대 200자).
CREATE TABLE participant_requests (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  participant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('correction', 'erase')),
  match_id TEXT,
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'declined')),
  reply TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK ((kind = 'correction') = (match_id IS NOT NULL))
);
CREATE INDEX idx_participant_requests_group ON participant_requests (group_id, created_at);
CREATE INDEX idx_participant_requests_person ON participant_requests (group_id, participant_id, status);

-- 본인 확인된 참가 신청: 신청한 멤버 계정. NULL = 익명 신청(링크를 가진 누구나 뺄 수 있음).
-- 값이 있으면 그 계정과 운영자만 뺄 수 있다(src/server/join.ts). 연결을 끊거나 탈퇴하면 NULL로 돌린다.
ALTER TABLE join_requests ADD COLUMN account_id TEXT;
