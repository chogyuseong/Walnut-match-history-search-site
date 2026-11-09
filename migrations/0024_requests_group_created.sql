-- 2026-11-09 서버 후속(docs/개선-서버-2026-11-09.md).
--
-- 쓰기 공통 경로(src/server/mutation.ts runMutation)는 저장 batch마다 그 모임의 오래된 요청 기록을 지운다:
--   DELETE FROM requests WHERE group_id = ?1 AND created_at < ?2
-- 지금 색인은 기본 키(group_id, request_id)와 idx_requests_created(created_at)뿐이라, 이 문장은 그 모임의 요청 기록
-- 전부(기본 키의 group_id 앞부분)나 모든 모임의 오래된 기록(created_at 색인)을 훑는다. 쓰기가 잦은 모임일수록
-- 쓰기 한 번마다 읽는 행이 늘어난다(D1 읽기 한도에 들어감). 아래 복합 색인으로 지울 행만 찾는다.
-- 표를 다시 쓰지 않는다. 만드는 동안 requests 전체를 한 번 읽는다(보관 기간이 지난 행은 계속 지워지므로 크지 않다).

CREATE INDEX idx_requests_group_created ON requests (group_id, created_at);
