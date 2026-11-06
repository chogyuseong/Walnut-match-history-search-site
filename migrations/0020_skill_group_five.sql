-- 티어 5단계(2026-11-06): participants.skill_group의 허용 범위를 1~4에서 1~5로 넓힌다. 이미 저장된 1~4는 그대로다.
-- SQLite는 CHECK를 고칠 수 없다. participants는 match_roster·rotation_events·participant_merges·support_adjustments·
-- join_requests의 복합 외래 키 대상이라 표를 새로 만들어 옮기는 방식(외래 키 끄기 필요)은 쓰지 않는다.
-- 대신 열만 바꾼다: 새 열(1~5 검사)을 더해 값을 옮기고, 옛 열을 지운 뒤 새 열 이름을 skill_group으로 바꾼다.
-- 옛 열은 색인·외래 키·다른 CHECK·뷰·트리거 어디에도 쓰이지 않아 DROP COLUMN이 허용된다.
-- 열 순서만 맨 뒤로 바뀐다(코드는 모두 열 이름으로 읽고 쓴다).
ALTER TABLE participants ADD COLUMN skill_group_new INTEGER
  CHECK (skill_group_new IS NULL OR skill_group_new BETWEEN 1 AND 5);
UPDATE participants SET skill_group_new = skill_group;
ALTER TABLE participants DROP COLUMN skill_group;
ALTER TABLE participants RENAME COLUMN skill_group_new TO skill_group;
