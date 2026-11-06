-- 기피 라인(2026-11-06). 사람마다 라인 섞기에서 되도록 피할 포지션.
-- 값: 포지션 이름을 쉼표로 이은 글자(탑·정글·미드·원딜·서폿 순서, 예: 'top,support'), 0~4개.
-- NULL = 없음. 5개 모두는 서버가 거절한다(src/shared/avoid.ts normalizeAvoidPositions).
-- 운영자 응답·백업에만 나가고 조회 링크 응답에는 넣지 않는다(src/server/snapshot.ts).
ALTER TABLE participants ADD COLUMN avoid_positions TEXT;
