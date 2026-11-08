-- 2026-11-08 리뷰 후속(docs/개선-서버-2026-11-08.md "2026-11-08 리뷰 후속").
--
-- 1) 스냅숏(src/server/snapshot.ts revisionStatements)의 변경 이력 질의 두 개가 모임의 이력 전부를 훑던 것을 줄인다.
-- - "변경 내역"(kind IN ('correction', 'exclude', 'restore'), id 내림차순 200줄): 예전에는 idx_revisions_group
--   (group_id, id)를 거꾸로 걸으며 종류를 하나씩 걸렀다. 정정은 드물어서 사실상 이력 전부(경기마다 시작·결과 2줄 이상)를 읽었다.
-- - 합치기 묶음(kind = 'correction'): 예전에는 모임의 이력 전부를 읽고 줄마다 합치기 판별 하위 질의를 돌렸다.
-- 아래 색인으로 두 질의 모두 그 종류의 줄만 읽는다(EXPLAIN QUERY PLAN으로 확인: SEARCH r USING INDEX
-- idx_revisions_group_kind (group_id=? AND kind=?)). id는 rowid라 색인에 저절로 들어가지만, 순서를 드러내려고 적는다.
-- "최근 이력"(종류 무관) 질의는 그대로 idx_revisions_group을 거꾸로 걸으며 200줄을 채우면 멈추므로 손대지 않는다.

CREATE INDEX idx_revisions_group_kind ON match_revisions (group_id, kind, id);

-- 2) guard.maintenance: 쓰기 공통 경로(src/server/mutation.ts runMutation)가 batch 안에서 점검 상태를 다시 확인하는
--    보호 문장. 예전에는 batch 밖에서 읽기만 해, 확인과 batch 실행 사이에 복원·모임 삭제가 점검을 켜면 그 쓰기가
--    점검 중인 모임에 저장될 수 있었다(복원 1단계가 지운 뒤 끼어든 쓰기는 다음 단계의 넣기와 부딪히거나 섞인다).
ALTER TABLE guard ADD COLUMN maintenance INTEGER CONSTRAINT guard_maintenance CHECK (maintenance IS NULL);
