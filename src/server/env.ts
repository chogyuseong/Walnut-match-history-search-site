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
   * "production"이면 운영 환경, "local"이면 로컬 개발·테스트다. "local"이 아니면(값이 없어도) AUTH_MODE가 fake이거나
   * 필수 값이 비어 있을 때 모든 API가 설정 오류로 거절된다(실수로 가짜 로그인이 열린 채 배포되는 것을 막는다).
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
  /** 운영자·멤버 스냅숏 GET 중 본문을 만드는 200의 한도(304는 세지 않음). 기본 계정당 30, IP당 60(창당). */
  RATE_SNAPSHOT_PER_ACCOUNT?: string;
  RATE_SNAPSHOT_PER_IP?: string;
  /** 자체 계정 가입·로그인·복구 코드 확인의 IP별 한도(창당). 기본 5·10·5. */
  RATE_SIGNUP_PER_IP?: string;
  RATE_LOGIN_PER_IP?: string;
  RATE_RECOVER_PER_IP?: string;
  /** 화면 오류 보고(POST /api/client-errors, 로그인 없음)의 IP별 한도(창당). 기본 10. */
  RATE_CLIENT_ERROR_PER_IP?: string;
  /**
   * 대량 쓰기 하루 예산(UTC 하루에 가져오기·지난 경기 입력·백업 복원으로 넣을 수 있는 경기 수).
   * 기본 계정당 3000, IP당 6000(src/server/ratelimit.ts spendBulkRows).
   */
  RATE_BULK_ROWS_PER_ACCOUNT?: string;
  RATE_BULK_ROWS_PER_IP?: string;

  /**
   * 사이트 운영자(이 서비스의 주인. 모임 운영자와 다르다). 쉼표로 구분한 계정 ID 목록.
   * 비어 있으면 아무도 현황 화면(#/admin, GET /api/admin/overview)을 못 본다(src/server/siteAdmin.ts).
   * 로컬 가짜 로그인에서만 "fake:로그인이름" 꼴도 받는다(가짜 로그인이 열려 있을 때만 맞춰 본다).
   */
  SITE_ADMIN_ACCOUNT_IDS?: string;

  /**
   * 자체 계정(아이디 + 비밀번호). "off"면 가입·로그인·복구·비밀번호 바꾸기 경로가 모두 404이고 화면에서도 숨는다.
   * 기본은 켜짐. 이미 로그인한 자체 계정의 세션은 끄더라도 만료·로그아웃 전까지 그대로다.
   */
  LOCAL_ACCOUNTS?: string;
  /**
   * 비밀번호 PBKDF2 반복 횟수. 기본·최대 100000(Workers 런타임의 상한). 저장한 해시에 횟수가 함께 적힌다.
   * 운영(무료 요금제, 요청당 CPU 10ms)은 20000으로 둔다(wrangler.jsonc). Paid로 올리면 100000으로 되돌린다.
   */
  PASSWORD_PBKDF2_ITERATIONS?: string;

  /** 복원 한 batch에 넣을 데이터 크기 상한(바이트). 넘으면 점검 상태에서 여러 단계로 나눠 넣는다. */
  RESTORE_BATCH_BYTES?: string;
  /** 모임 삭제 한 batch에서 지울 행 수 상한. 넘으면 점검 상태에서 여러 단계로 나눠 지운다(src/server/deletion.ts). */
  GROUP_DELETE_BATCH_ROWS?: string;

  /**
   * 자동 백업(src/server/backupCron.ts)을 넣을 R2 버킷. 없으면 예정 작업이 아무것도 하지 않고 로그만 남긴다.
   * 운영 버킷: naejeon-prod-backups(docs/배포안내.md).
   */
  BACKUPS?: R2Bucket;
  /** 예정 작업 한 번에 백업할 모임 수 상한. 기본 5. 나머지는 다음 실행이 이어서 한다. */
  BACKUP_GROUPS_PER_RUN?: string;
  /** 자동 백업 보관 날수. 기본 30. */
  BACKUP_KEEP_DAYS?: string;

  /**
   * 배포 버전 정보(wrangler.jsonc의 version_metadata). 스냅숏 ETag에 넣어, 새 코드를 배포하면
   * 자료가 그대로여도 예전 응답 본문을 다시 쓰지 않게 한다(응답 모양이 바뀌었을 수 있다). 없으면 빈 값.
   */
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
}
