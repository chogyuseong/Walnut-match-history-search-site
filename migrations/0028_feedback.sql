-- 피드백(2026-11-13, 시험 운영 기간). 누구나 로그인 없이 불편한 점을 적어 보내고, 사이트 운영자만 읽는다.
-- 개인정보를 따로 받지 않는다: 계정 ID·IP·쿠키·연락처는 저장하지 않는다. 글 안에 이름 등을 적을 수는 있어
-- 개인정보 처리방침(src/web/screens/Privacy.tsx)에 항목을 두었다.
-- 보관 한도(최근 500건, 180일)는 넣을 때마다 정리한다(src/server/feedback.ts).

CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  body TEXT NOT NULL,
  app_version TEXT,
  -- 브라우저 종류만(예: "Chrome 모바일"). User-Agent 원문은 저장하지 않는다.
  browser TEXT
);
CREATE INDEX idx_feedback_created ON feedback (created_at);
