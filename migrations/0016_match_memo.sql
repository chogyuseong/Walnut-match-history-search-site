-- 경기 메모(2026-11-06). 경기마다 짧은 메모 한 칸(최대 200자, 줄바꿈 허용). 비우면 NULL.
-- 공개 정보로 다룬다: 운영자 응답·조회 링크 응답·백업에 모두 들어간다.
-- 승패 정정 이력(match_revisions)에는 남기지 않는다(그 표의 kind CHECK를 바꾸려면 표를 새로 만들어야 하고,
-- 메모는 결과가 아니라 덧붙인 글이라 "변경 내역"에 섞지 않는다). 경기 버전(version)도 올리지 않는다:
-- 다른 운영자가 열어 둔 결과 입력·정정 창이 메모 때문에 충돌하지 않게 한다. 메모끼리의 충돌은 직전 값 비교로 막는다.
ALTER TABLE matches ADD COLUMN memo TEXT CHECK (memo IS NULL OR length(memo) BETWEEN 1 AND 200);
