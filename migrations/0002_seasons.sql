-- 시즌: 운영자가 모임 단위로 만드는 날짜 구간(docs/P2 P2-11).
-- 서로 겹치지 않는다. 통계 필터로만 쓰이고 배치·칭호에는 영향이 없다.
-- 날짜는 모임 표시 시간대 기준의 YYYY-MM-DD이고 양 끝을 포함한다.

CREATE TABLE seasons (
  id TEXT NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups (id),
  name TEXT NOT NULL,
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (group_id, id),
  CONSTRAINT season_range CHECK (starts_on <= ends_on),
  CONSTRAINT season_date_format CHECK (
    starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  )
);
CREATE INDEX idx_seasons_group ON seasons (group_id, starts_on);
