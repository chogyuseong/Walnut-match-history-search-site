-- 경기 삭제(휴지통 방식). 잘못 넣었거나 두 번 넣은 경기를 운영자가 지운다.
-- 지운 경기는 행과 딸린 자료(명단·시리즈 소속·변경 이력·서포터 차례 기록)를 그대로 두고 deleted_at만 채운다.
-- 서버가 읽는 곳마다 deleted_at IS NULL로 걸러 모든 화면·계산·조회 링크에서 빠진다(src/server/snapshot.ts).
-- 되살리면 NULL로 돌린다. state는 건드리지 않으므로 지우기 전 상태(확정·전적 제외·결과 미입력)가 그대로 돌아온다.
-- 경기 번호(match_no·groups.next_match_no)는 당기지 않는다: 지운 번호는 빈 채로 남는다.
--
-- 상태 CHECK에 'deleted'를 더하지 않고 칸을 따로 둔 이유: CHECK를 바꾸려면 matches 표를 새로 만들어야 하는데
-- 운영 DB에 경기가 수백 개 있고 명단·시리즈·이력이 외래 키로 걸려 있다. 칸 추가는 기존 행을 건드리지 않는다.
-- 삭제·되살리기 이력도 같은 이유로 match_revisions의 kind CHECK를 바꾸지 않고 kind 'correction'에
-- changes.deleted({from: false, to: true} 또는 그 반대)로 남긴다.
-- 칸만 더하므로 이 마이그레이션을 먼저 적용해도 예전 코드는 이 칸을 모른 채 그대로 돈다.
ALTER TABLE matches ADD COLUMN deleted_at TEXT;

-- 지금 지워진 경기의 가장 최근 삭제 줄을 읽는 스냅숏 질의(src/server/snapshot.ts revisionStatements, DELETED_MATCH_LINES)용
-- 부분 색인. 이 색인이 없으면 지운 경기가 하나도 없어도 스냅숏마다 그 모임의 정정 줄 전부와 그만큼의 경기 행을 읽는다
-- (D1 무료 한도에서 가장 빠듯한 것이 행 읽기다). 삭제·되살리기 줄만 들어가므로 색인 크기는 그 줄 수만큼이다.
-- 주의: 계획기는 질의의 WHERE가 아래 조건(kind = 'correction' AND json_type(changes, '$.deleted') IS NOT NULL)을
-- 글자 그대로 포함할 때만 이 부분 색인을 쓴다. 삭제 줄 질의의 조건을 바꾸면 이 색인 조건도 같이 바꿔야 한다.
CREATE INDEX idx_revisions_deleted_lines ON match_revisions (group_id, match_id)
  WHERE kind = 'correction' AND json_type(changes, '$.deleted') IS NOT NULL;
