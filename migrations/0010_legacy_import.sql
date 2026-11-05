-- 기존 사이트(v1, Apps Script 웹 앱) 기록 가져오기. 일괄 입력 묶음의 출처 종류에 'legacy'를 더하고,
-- 가져올 때 고른 날짜 기준을 남길 열을 더한다.
--
-- SQLite는 CHECK 제약을 고칠 수 없어서 import_batches를 새로 만들어 옮긴다(이 표를 참조하는 외래 키는 없다.
-- matches.import_batch_id는 값만 같고 외래 키가 아니다). 이전 앱 버전도 새 표에서 그대로 동작한다
-- (열 이름·키가 같고, 이전 버전은 'paste'·'sheet'만 넣는다).
--   kind      : 'paste' | 'sheet' | 'legacy'(기존 사이트 연결 주소로 읽음)
--   source_key: 'legacy:{배포 ID}' 도 받는다. 시트 ID와 같이 조회 응답(스냅숏)에는 내보내지 않는다.
--   options   : 기존 사이트 가져오기에서 고른 날짜 처리 {"futureMode":"shift"|"drop","from":"YYYY-MM-DD"}(JSON).
--               같은 주소로 다시 가져올 때 같은 기준을 기본값으로 보여 준다. 그 밖의 종류는 NULL.
CREATE TABLE import_batches_new (
  group_id TEXT NOT NULL REFERENCES groups (id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('paste', 'sheet', 'legacy')),
  source_key TEXT,
  label TEXT,
  created_at TEXT NOT NULL,
  options TEXT,
  PRIMARY KEY (group_id, id)
);
INSERT INTO import_batches_new (group_id, id, kind, source_key, label, created_at)
  SELECT group_id, id, kind, source_key, label, created_at FROM import_batches;
DROP TABLE import_batches;
ALTER TABLE import_batches_new RENAME TO import_batches;
