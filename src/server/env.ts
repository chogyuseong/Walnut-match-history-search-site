export interface Env {
  DB: D1Database;
  /** "fake"는 로컬·테스트 전용 로그인이다. */
  AUTH_MODE: string;
  /** 세션 쿠키 서명 키. 저장소에 넣지 않는다. */
  SESSION_SECRET: string;
}
