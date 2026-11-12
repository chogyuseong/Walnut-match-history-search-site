-- 서포터 차례 기록(rotation_events)을 주기·사람으로 찾는 색인. 색인만 더하므로 먼저 적용해도 예전 코드는 그대로 돈다.
--
-- 이 표에는 모임 조건으로 찾을 색인이 없어서 아래 질의가 모든 모임의 차례 기록을 훑었다(test/snapshot-rows.test.ts,
-- 다른 모임 기록 2,000행일 때 질의마다 약 2,010행).
-- - 주기로 찾기(cycle_id = ? AND voided = 0): 스냅숏의 "순환 차례 기록"(src/server/snapshot.ts), 서포터 횟수
--   (supportCounts.ts). 기존 uq_rotation_used는 kind = 'used' AND voided = 0 부분 색인이라 반복 사건까지 읽는
--   이 질의에는 쓸 수 없다.
-- - 경기 취소의 "뒤 경기 반복 사건"(matches.ts cancelMatch): 이 경기의 사용 사건에서 출발해 같은 주기·같은 사람의
--   반복 사건을 (cycle_id, participant_id)로 찾는다.
-- - 참가자 합치기(merge.ts): group_id = ? AND participant_id = ?. 참가자 ID는 모임 사이에 겹치지 않아 participant_id만으로
--   충분하다. (group_id, participant_id)로 만들지 않은 것은 통계 없는 D1 계획기가 `group_id = ? AND id IN (...)` 같은
--   질의에서 기본 키 대신 group_id 색인을 골라 그 모임의 기록 전부를 훑을 수 있어서다(snapshot.ts ROSTER_IN_GROUP와 같은 문제).
CREATE INDEX idx_rotation_cycle ON rotation_events (cycle_id, participant_id);
CREATE INDEX idx_rotation_participant ON rotation_events (participant_id);
