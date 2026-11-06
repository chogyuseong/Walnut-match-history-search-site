-- 공동 운영자. group_operators(모임당 1명)는 그대로 두고 "대표 운영자"로 본다(표를 다시 만들지 않는다).
-- 공동 운영자는 대표 운영자와 같은 일을 하되 운영자 넘기기·모임 삭제·백업에서 복원·공동 운영자 초대와
-- 내보내기는 하지 못한다(서버에서 거절, src/server/auth.ts requireOwner). 모임당 최대 5명은 서버가 지킨다.
-- 백업 파일에는 넣지 않고, 복원해도 지우지 않는다(GROUP_DATA_TABLES에 넣지 않는다).
CREATE TABLE group_co_operators (
  group_id TEXT NOT NULL REFERENCES groups (id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, account_id)
);
CREATE INDEX idx_group_co_operators_account ON group_co_operators (account_id);

-- 공동 운영자 초대 링크. 운영자 넘기기 링크(operator_transfers)와 같은 방식:
-- 1회용, 24시간 뒤 만료, 토큰 원문이 아니라 해시만 저장, 새로 만들면 쓰지 않은 이전 링크는 지운다.
CREATE TABLE co_operator_invites (
  token_hash TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_co_operator_invites_group ON co_operator_invites (group_id);
