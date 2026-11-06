-- 오류 기록(2026-11-06). 화면(client)과 서버(server)에서 난 예상하지 못한 오류를 사이트 운영자가 본다.
-- 개인정보를 넣지 않는다: 계정 ID·IP·쿠키·요청 본문·참가자 이름은 저장하지 않는다.
-- 경로의 토큰·ID, 메시지·스택 속 주소의 토큰은 넣기 전에 가린다(src/shared/errorScrub.ts).
-- 보관 한도(최근 1000건, 30일)는 넣을 때마다 정리한다(src/server/errorLog.ts).

CREATE TABLE error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('client', 'server')),
  -- client: error(window.onerror) · rejection(unhandledrejection) · boundary(React 오류 경계). server: server.
  kind TEXT NOT NULL CHECK (kind IN ('error', 'rejection', 'boundary', 'server')),
  message TEXT NOT NULL,
  -- 앞부분만(길이를 자른다).
  stack TEXT,
  -- 화면 경로(#/...) 또는 API 경로. 토큰·ID는 가린 값.
  path TEXT,
  app_version TEXT,
  -- 브라우저 종류만(예: "Chrome 모바일"). User-Agent 원문은 저장하지 않는다.
  browser TEXT
);
CREATE INDEX idx_error_logs_created ON error_logs (created_at);

-- 요청 수 제한에 걸린 횟수(날짜·종류별 합계만). 사이트 운영자 현황 화면이 쓴다. 누가 걸렸는지는 남기지 않는다.
CREATE TABLE rate_limit_hits (
  day TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, bucket)
);
