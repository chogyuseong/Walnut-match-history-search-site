-- 서포터 횟수 직접 입력(보정값). 2026-11-06.
-- 화면·규칙에 쓰는 횟수 = 그 주기의 유효 서포터 사건 수(rotation_events, 무효 제외) + 보정값. 0 미만이면 0으로 본다.
-- 사용자가 "N회"로 정하면 서버가 그 시점 사건 수와의 차이를 보정값으로 저장한다. 그 뒤 실제 경기로 간 횟수는 계속 더해진다.
-- cycle_id가 NULL인 행: 활성 주기가 없을 때(첫 경기 전) 넣은 값. 다음 경기 시작이 새 주기를 열 때 그 주기로 옮긴다.
-- 새 주기(초기화·새 내전)에는 보정값이 없다. 닫힌 주기의 행은 남지만 쓰이지 않는다.
-- 서버의 반복 확인(SUPPORT_REPEAT)은 지금처럼 'used' 사건만 본다(보정값은 보지 않는다).
CREATE TABLE support_adjustments (
  group_id TEXT NOT NULL REFERENCES groups (id),
  cycle_id TEXT,
  participant_id TEXT NOT NULL,
  delta INTEGER NOT NULL CHECK (delta BETWEEN -100000 AND 100000),
  updated_at TEXT NOT NULL,
  -- 복합 외래 키: 다른 모임의 주기·참가자를 연결할 수 없다(cycle_id가 NULL이면 주기 검사는 건너뛴다).
  FOREIGN KEY (group_id, cycle_id) REFERENCES rotation_cycles (group_id, id),
  FOREIGN KEY (group_id, participant_id) REFERENCES participants (group_id, id)
);
-- 주기(또는 "주기 없음")마다 한 사람에 한 행.
CREATE UNIQUE INDEX uq_support_adjustments
  ON support_adjustments (group_id, ifnull(cycle_id, ''), participant_id);
