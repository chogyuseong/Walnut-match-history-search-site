-- 구글 시트에서 가져오기(작업 F). 확장만 한다(열·표 추가). 이전 앱 버전도 이 스키마에서 그대로 동작한다.
--
-- 다시 가져오기 중복 방지: 일괄 입력으로 넣은 경기마다 시트 내용의 지문과 줄 위치 열쇠를 남긴다.
--   import_fingerprint: 날짜(시각), 양 팀의 (라인:이름), 이긴 팀으로 만든 지문(src/shared/sheetTable.ts).
--                       같은 시트를 다시 가져오면 같은 지문의 경기는 건너뛴다.
--   import_row_key    : "날짜#같은 날 순서". 같은 자리의 줄이 시트에서 고쳐졌는지(바뀐 줄) 찾는 데 쓴다.
-- 지문은 가져올 때의 시트 내용이다. 앱에서 경기를 정정해도 바뀌지 않는다(그래야 다시 가져올 때 건너뛴다).
ALTER TABLE matches ADD COLUMN import_fingerprint TEXT;
ALTER TABLE matches ADD COLUMN import_row_key TEXT;
CREATE INDEX idx_matches_import_fingerprint ON matches (group_id, import_fingerprint)
  WHERE import_fingerprint IS NOT NULL;

-- 일괄 입력 한 번(묶음)의 출처. 묶음 ID는 matches.import_batch_id와 같다.
--   kind      : 'paste'(붙여 넣기) | 'sheet'(구글 시트 주소로 읽음)
--   source_key: 'sheet:{문서 ID}:{gid}' 또는 'pub:{게시 ID}:{gid}'. 붙여 넣기는 NULL.
--   label     : 화면에 보일 이름(시트 제목 - 탭 이름). 시트가 알려준 값이며 없을 수 있다.
-- 묶음 ID는 화면이 만든다. 다른 모임과 겹쳐도 되도록 (모임, 묶음 ID)를 키로 쓴다.
CREATE TABLE import_batches (
  group_id TEXT NOT NULL REFERENCES groups (id),
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('paste', 'sheet')),
  source_key TEXT,
  label TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, id)
);
