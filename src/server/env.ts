export interface Env {
  DB: D1Database;
  /**
   * "fake": 로컬·테스트 전용 가짜 로그인을 연다.
   * "oauth": 카카오·Google 로그인만 쓴다. 그 밖의 값도 "oauth"로 다룬다(가짜 로그인은 닫힌다).
   */
  AUTH_MODE: string;
  /** 세션 쿠키 서명 키. 저장소에 넣지 않는다(.dev.vars 또는 wrangler secret). */
  SESSION_SECRET: string;
  /**
   * "production"이면 운영 환경이다. 운영에서 AUTH_MODE가 fake이거나 필수 값이 비어 있으면
   * 모든 API가 설정 오류로 거절된다(실수로 가짜 로그인이 열린 채 배포되는 것을 막는다).
   */
  DEPLOY_ENV?: string;
  /** 서비스 주소(예: https://naejeon.example.com). OAuth 리디렉션 URI를 이 값으로 고정한다. */
  PUBLIC_ORIGIN?: string;
  /** 세션 유지 시간(시간 단위). 기본 720시간(30일). */
  SESSION_TTL_HOURS?: string;

  /** 카카오 로그인: REST API 키와 클라이언트 시크릿. 키가 있어야 로그인 버튼이 보인다. */
  KAKAO_CLIENT_ID?: string;
  KAKAO_CLIENT_SECRET?: string;
  /** Google 로그인: OAuth 클라이언트 ID와 시크릿. 둘 다 있어야 로그인 버튼이 보인다. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  /** 요청 수 제한(고정 창). 값이 없으면 src/server/ratelimit.ts의 기본값을 쓴다. */
  RATE_WINDOW_SECONDS?: string;
  RATE_WRITE_PER_ACCOUNT?: string;
  RATE_WRITE_PER_IP?: string;
  RATE_AUTH_PER_IP?: string;
  RATE_VIEW_PER_IP?: string;
  /** 구글 시트 읽기(바깥 요청) 한도. 기본 계정당 10, IP당 20(창당). */
  RATE_SHEET_PER_ACCOUNT?: string;
  RATE_SHEET_PER_IP?: string;
  /** 비싼 읽기(백업 내려받기·합치기 미리보기·가져오기 지문 목록) 한도. 기본 계정당 60, IP당 120(창당). */
  RATE_HEAVY_PER_ACCOUNT?: string;
  RATE_HEAVY_PER_IP?: string;
  /** 자체 계정 가입·로그인·복구 코드 확인의 IP별 한도(창당). 기본 5·10·5. */
  RATE_SIGNUP_PER_IP?: string;
  RATE_LOGIN_PER_IP?: string;
  RATE_RECOVER_PER_IP?: string;

  /**
   * 자체 계정(아이디 + 비밀번호). "off"면 가입·로그인·복구·비밀번호 바꾸기 경로가 모두 404이고 화면에서도 숨는다.
   * 기본은 켜짐. 이미 로그인한 자체 계정의 세션은 끄더라도 만료·로그아웃 전까지 그대로다.
   */
  LOCAL_ACCOUNTS?: string;
  /** 비밀번호 PBKDF2 반복 횟수. 기본·최대 100000(Workers 런타임의 상한). 저장한 해시에 횟수가 함께 적힌다. */
  PASSWORD_PBKDF2_ITERATIONS?: string;

  /** 복원 한 batch에 넣을 데이터 크기 상한(바이트). 넘으면 점검 상태에서 여러 단계로 나눠 넣는다. */
  RESTORE_BATCH_BYTES?: string;
  /** 모임 삭제 한 batch에서 지울 행 수 상한. 넘으면 점검 상태에서 여러 단계로 나눠 지운다(src/server/deletion.ts). */
  GROUP_DELETE_BATCH_ROWS?: string;
}
