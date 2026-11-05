-- 자체 계정(아이디 + 비밀번호). 확장만 한다(표 추가). 이전 앱 버전도 이 스키마에서 그대로 동작한다.
--
-- 계정 행은 기존 accounts 표를 그대로 쓴다: provider = 'local', subject = 정규화한 아이디(영문 소문자·숫자·밑줄).
-- (provider, subject) 유일 조건이 아이디 중복을 막는다.
-- 비밀번호와 복구 코드는 원문을 저장하지 않는다. 해시 문자열에 방식·매개변수를 함께 적는다:
--   password_hash: pbkdf2-sha256$<반복 횟수>$<솔트 base64url>$<해시 base64url>  (계정마다 무작위 16바이트 솔트)
--   recovery_hash: sha256$<16진수>  (복구 코드는 160비트 무작위 값이라 빠른 해시로 충분하다)
-- 탈퇴하면 이 행도 함께 지운다(src/server/deletion.ts). 백업 파일에는 들어가지 않는다.
CREATE TABLE local_credentials (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id),
  password_hash TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 아이디·계정별 인증 실패 횟수(고정 창, 기본 15분). 요청 수 제한(rate_limits, 60초 창)과 창 길이가 달라 따로 둔다.
-- key: "login:<아이디 HMAC>" | "recover:<아이디 HMAC>" | "password:<계정 ID>". 아이디 원문은 저장하지 않는다.
-- 없는 아이디의 실패도 같은 방식으로 세어, 응답으로 아이디가 있는지 드러나지 않게 한다.
CREATE TABLE auth_failures (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX idx_auth_failures_window ON auth_failures (window_start);
