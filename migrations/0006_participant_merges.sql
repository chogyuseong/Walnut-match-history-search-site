-- 중복 참가자 합치기(작업 D). 확장만 한다(표 추가). 이전 앱 버전도 이 스키마에서 그대로 동작한다.
--
-- 같은 사람이 두 이름으로 들어간 경우 "합칠 대상(source)"의 기록을 "남길 대상(target)"으로 옮긴다.
-- 원본 행을 지우지 않는다: 합칠 대상 참가자 행은 보관 상태로 남고, 옮긴 행 목록을 이 표에 남겨
-- 되돌리기(undone_at)가 그 행들만 원래대로 돌려놓는다.
--
--   moved_matches    : 합칠 대상이 명단에 있던 경기 ID 목록(JSON 배열). 명단 행 (경기, 참가자)를 옮겼다.
--   rotation_changes : 바꾼 서포터 차례 기록(JSON 배열).
--                      [{"id", "participantFrom", "participantTo", "kindFrom", "kindTo"}]
--                      같은 주기에 두 사람이 각각 차례를 썼으면 늦은 쪽을 "반복 허용"으로 바꾼 기록도 들어간다.
--   source_prev_status: 합치기 전 합칠 대상의 상태. 되돌릴 때 이 상태로 돌린다.

CREATE TABLE participant_merges (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source_prev_status TEXT NOT NULL CHECK (source_prev_status IN ('active', 'archived')),
  moved_matches TEXT NOT NULL,
  rotation_changes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  undone_at TEXT,
  CONSTRAINT merge_not_self CHECK (source_id <> target_id),
  FOREIGN KEY (group_id, source_id) REFERENCES participants (group_id, id),
  FOREIGN KEY (group_id, target_id) REFERENCES participants (group_id, id)
);
-- 한 사람은 한 번에 한 곳으로만 합쳐져 있다(되돌린 기록은 세지 않는다).
CREATE UNIQUE INDEX uq_merges_active_source ON participant_merges (source_id) WHERE undone_at IS NULL;
CREATE INDEX idx_merges_group ON participant_merges (group_id, created_at);
