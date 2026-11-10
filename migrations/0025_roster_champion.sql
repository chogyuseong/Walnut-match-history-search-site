-- 경기 명단의 챔피언(2026-11-10). 결과 입력 때 고르거나 경기 상세에서 나중에 넣는 선택 항목이다. 비우면 NULL.
-- 값은 챔피언 고정 키(영문 식별자, 예 'Ahri'). 목록은 src/shared/champions.ts에 있고 서버가 저장 전에 검사한다.
-- 목록이 코드에 있어 새 챔피언이 나올 때마다 CHECK를 고칠 수 없으므로 DB에는 글자 길이만 건다.
-- 칸 추가만 한다(기존 행은 NULL로 남는다). 되돌릴 때는 코드만 예전으로 돌려도 이 칸은 무시된다.
-- data_version 트리거는 명단 표에 없다(migrations/0021): 챔피언을 바꾸는 쓰기는 같은 batch에서 matches.version을 올린다.
ALTER TABLE match_roster ADD COLUMN champion TEXT CHECK (champion IS NULL OR length(champion) BETWEEN 1 AND 32);
