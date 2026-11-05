-- 내전 운영 서비스 v2 초기 스키마 (docs/P2 P2-1, P2-3)
-- 모든 하위 표는 group_id를 가진다. 시각은 UTC ISO 8601 문자열이다.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, subject)
);

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  -- 진행 상태 버전: 세션·진행 중 경기·순환 주기가 바뀔 때마다 오른다.
  live_version INTEGER NOT NULL DEFAULT 0,
  settings_version_id TEXT,
  view_token TEXT NOT NULL UNIQUE,
  maintenance INTEGER NOT NULL DEFAULT 0 CHECK (maintenance IN (0, 1)),
  next_match_no INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- 모임당 활성 운영자 1명: group_id가 기본 키다.
CREATE TABLE group_operators (
  group_id TEXT PRIMARY KEY REFERENCES groups (id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_group_operators_account ON group_operators (account_id);

CREATE TABLE settings_versions (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups (id),
  version_no INTEGER NOT NULL,
  -- 전체 스냅샷(JSON). 병합하지 않는다.
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (group_id, version_no)
);

CREATE TABLE participants (
  id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups (id),
  name TEXT NOT NULL,
  -- 정규화한 이름: 앞뒤 공백 제거, 연속 공백 1개, 소문자.
  name_key TEXT NOT NULL,
  -- 1~4 또는 NULL(미지정). 미지정은 낮은 실력이 아니다.
  skill_group INTEGER CHECK (skill_group IS NULL OR skill_group BETWEEN 1 AND 4),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (group_id, id)
);
CREATE UNIQUE INDEX uq_participants_active_name
  ON participants (group_id, name_key) WHERE status = 'active';

CREATE TABLE sessions (
  id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups (id),
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (id),
  UNIQUE (group_id, id)
);
-- 모임당 열린 세션 1개.
CREATE UNIQUE INDEX uq_sessions_open ON sessions (group_id) WHERE closed_at IS NULL;

CREATE TABLE matches (
  id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups (id),
  match_no INTEGER NOT NULL,
  session_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('in_progress', 'awaiting_result', 'confirmed', 'canceled', 'excluded')),
  -- 전적 제외 직전 상태. 복구할 때 쓴다.
  prev_state TEXT CHECK (prev_state IS NULL OR prev_state IN ('awaiting_result', 'confirmed')),
  source TEXT NOT NULL CHECK (source IN ('live', 'backfill', 'import')),
  started_at TEXT,
  ended_at TEXT,
  played_at TEXT NOT NULL,
  confirmed_at TEXT,
  winner_team TEXT CHECK (winner_team IS NULL OR winner_team IN ('A', 'B')),
  -- 진영은 "팀 A의 진영" 한 칸으로만 저장한다. 팀 B는 항상 그 반대다.
  team_a_side TEXT CHECK (team_a_side IS NULL OR team_a_side IN ('blue', 'red', 'unknown')),
  settings_version_id TEXT,
  -- 경기 버전: 이 경기가 바뀔 때마다 오른다.
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE (group_id, id),
  UNIQUE (group_id, match_no),
  FOREIGN KEY (group_id, session_id) REFERENCES sessions (group_id, id),
  -- 결과 확정 경기는 승리 팀과 진영 값(미상 포함)을 반드시 가진다.
  CONSTRAINT confirmed_has_result CHECK (
    state <> 'confirmed' OR (winner_team IS NOT NULL AND team_a_side IS NOT NULL)
  )
);
-- 모임당 진행 중 경기 1개.
CREATE UNIQUE INDEX uq_matches_in_progress ON matches (group_id) WHERE state = 'in_progress';
CREATE INDEX idx_matches_group_state ON matches (group_id, state, played_at);

CREATE TABLE match_roster (
  match_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  team TEXT NOT NULL CHECK (team IN ('A', 'B')),
  position TEXT CHECK (position IS NULL OR position IN ('top', 'jungle', 'mid', 'adc', 'support')),
  PRIMARY KEY (match_id, participant_id),
  -- 복합 외래 키: 다른 모임의 참가자·경기를 연결할 수 없다.
  FOREIGN KEY (group_id, match_id) REFERENCES matches (group_id, id),
  FOREIGN KEY (group_id, participant_id) REFERENCES participants (group_id, id)
);
-- 팀 내 포지션 중복 없음(포지션이 있는 행만).
CREATE UNIQUE INDEX uq_roster_team_position
  ON match_roster (match_id, team, position) WHERE position IS NOT NULL;
CREATE INDEX idx_roster_participant ON match_roster (group_id, participant_id);

-- 변경 이력: 추가만 한다.
CREATE TABLE match_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'end', 'result', 'correction', 'exclude', 'restore', 'cancel', 'backfill')),
  -- {"항목": {"from": ..., "to": ...}} 형태의 JSON.
  changes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (group_id, match_id) REFERENCES matches (group_id, id)
);
CREATE INDEX idx_revisions_group ON match_revisions (group_id, id);

CREATE TABLE rotation_cycles (
  id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups (id),
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_at TEXT NOT NULL,
  closed_at TEXT,
  PRIMARY KEY (id),
  UNIQUE (group_id, id),
  FOREIGN KEY (group_id, session_id) REFERENCES sessions (group_id, id)
);
-- 세션당 활성 주기 1개.
CREATE UNIQUE INDEX uq_cycles_active ON rotation_cycles (session_id) WHERE status = 'active';

CREATE TABLE rotation_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  -- used: 차례 사용. repeat: 이번 경기만 반복 허용(주기 사용 인원에 더하지 않는다).
  kind TEXT NOT NULL CHECK (kind IN ('used', 'repeat')),
  voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (group_id, cycle_id) REFERENCES rotation_cycles (group_id, id),
  FOREIGN KEY (group_id, match_id) REFERENCES matches (group_id, id),
  FOREIGN KEY (group_id, participant_id) REFERENCES participants (group_id, id)
);
-- 한 주기에서 한 사람의 "사용"은 1회.
CREATE UNIQUE INDEX uq_rotation_used
  ON rotation_events (cycle_id, participant_id) WHERE kind = 'used' AND voided = 0;
CREATE INDEX idx_rotation_match ON rotation_events (match_id);

-- 요청 기록: 같은 확정 의도를 한 번만 저장한다. 14일 보존.
CREATE TABLE requests (
  group_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, request_id)
);
CREATE INDEX idx_requests_created ON requests (created_at);

-- 보호 표: batch 안에서 조건이 어긋나면 값을 넣어 CHECK 위반을 일으키고,
-- 그 실패가 batch 전체를 되돌린다. 정상 경로에서는 행이 들어가지 않는다.
CREATE TABLE guard (
  version_conflict INTEGER,
  state_conflict INTEGER,
  CONSTRAINT guard_version_conflict CHECK (version_conflict IS NULL),
  CONSTRAINT guard_state_conflict CHECK (state_conflict IS NULL)
);
