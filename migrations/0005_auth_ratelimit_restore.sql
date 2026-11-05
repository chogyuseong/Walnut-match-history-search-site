-- 실제 로그인·요청 수 제한·백업 복원(작업 B).
-- 확장만 한다(열·표 추가). 이전 앱 버전도 이 스키마에서 그대로 동작한다(docs/P4 P4-2).

-- 세션 세대: 로그아웃하면 1 오르고, 그 전에 발급한 이 계정의 세션 쿠키는 모두 거절된다.
-- 계정 표의 나머지 구조(provider + subject 유일)는 가짜 로그인과 실제 로그인이 같이 쓴다.
--   provider: 'fake' | 'kakao' | 'google', subject: 제공자의 고유 ID(카카오 회원번호, Google sub)
ALTER TABLE accounts ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;

-- 모임 세대: 백업 복원이 끝날 때마다 1 오른다.
-- 화면은 마지막으로 받은 세대를 요청에 실어 보내고, 서버는 다르면 거절한다(복원 전에 열린 탭 차단).
ALTER TABLE groups ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;

-- 진행 중인 복원. 한 batch에 다 넣지 못하는 큰 복원은 여러 단계로 나눠 실행하는데,
-- 그동안 모임은 점검 상태(groups.maintenance = 1)이고 이 행이 남아 있다.
-- 중간에 끊기면 같은 모임의 운영자가 백업 파일로 복원을 다시 실행해 끝낼 수 있다.
CREATE TABLE restore_jobs (
  group_id TEXT PRIMARY KEY REFERENCES groups (id),
  started_at TEXT NOT NULL
);

-- 요청 수 제한(고정 창). key는 "종류:계정 ID" 또는 "종류:IP 해시"다. IP 원문은 저장하지 않는다.
-- 지난 창의 행은 요청이 올 때 함께 지운다.
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX idx_rate_limits_window ON rate_limits (window_start);
