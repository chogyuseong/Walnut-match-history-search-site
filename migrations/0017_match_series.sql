-- 시리즈 묶음(2026-11-06). 여러 경기를 한 시리즈(3판 2선승 등)로 묶는다.
-- 통계(승률·랭킹)는 지금처럼 판 단위로 센다. 시리즈는 묶어서 보여 주는 것뿐이다.
-- 시리즈 점수는 "같은 사람들로 이뤄진 팀" 기준이다(진영은 판마다 바뀔 수 있다). 넣을 때 서버가 두 팀의 5명 구성이
-- 시리즈의 첫 판과 같은지 확인한다. 점수는 저장하지 않고 화면에서 매번 계산한다(src/shared/series.ts).

CREATE TABLE match_series (
  id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups (id),
  -- 선택(예: "결승"). 없으면 NULL.
  name TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 20),
  -- bo3: 3판 2선승, bo5: 5판 3선승, free: 자유(판 수 제한 없음).
  format TEXT NOT NULL CHECK (format IN ('bo3', 'bo5', 'free')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (group_id, id)
);

-- 시리즈에 속한 경기. 한 경기는 한 시리즈에만 들어간다(기본 키가 match_id).
-- 복합 외래 키: 다른 모임의 경기·시리즈를 연결할 수 없다.
CREATE TABLE match_series_members (
  group_id TEXT NOT NULL,
  series_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (match_id),
  FOREIGN KEY (group_id, series_id) REFERENCES match_series (group_id, id),
  FOREIGN KEY (group_id, match_id) REFERENCES matches (group_id, id)
);
CREATE INDEX idx_series_members ON match_series_members (group_id, series_id);
