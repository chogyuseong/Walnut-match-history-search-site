-- 표 일괄 입력으로 넣은 경기를 묶음 단위로 되돌릴 수 있게 묶음 ID를 남긴다.
ALTER TABLE matches ADD COLUMN import_batch_id TEXT;
CREATE INDEX idx_matches_import_batch ON matches (group_id, import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- 운영자 인수 링크(docs/P2 P2-9). 1회용이고 24시간 뒤 만료된다.
-- 링크의 토큰 자체가 아니라 해시만 저장한다.
CREATE TABLE operator_transfers (
  token_hash TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX idx_operator_transfers_group ON operator_transfers (group_id);
