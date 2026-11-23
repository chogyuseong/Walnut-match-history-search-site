// 방문자 수 보기(Cloudflare Web Analytics). vite.config.ts가 빌드 때만 쓴다.
//
// 운영 빌드(--mode deploy-production)이고 WEB_ANALYTICS_TOKEN이 있을 때만 index.html 끝에 비컨 스크립트를 넣는다.
// staging·로컬은 넣지 않는다(시험 접속이 방문자 수에 섞이지 않게).
// workers.dev 주소는 Cloudflare 자동 설정이 안 되고 스크립트를 직접 넣어야 한다(공식 FAQ "Can I use automatic setup…").
//
// 같이 맞춰야 하는 곳:
// - CSP: script-src에 BEACON_SRC, connect-src에 cloudflareinsights.com(src/server/http.ts와 public/_headers 두 곳).
//   공식 FAQ "What do I need to add to my Content Security Policy" 그대로다.
// - 개인정보 처리방침(src/web/screens/Privacy.tsx): 켜진 빌드에서만 "다른 회사에 전달되는 것"에 한 줄이 보인다.
//   켜는 날 legal.ts의 시행일도 바꾼다.
//
// 화면 주소가 해시 방식(#/...)이라 주소마다의 조회수는 정확하지 않다. 보려는 것은 하루 방문자와 들어온 경로다.

/** Cloudflare 대시보드 → Web Analytics → 사이트 추가(naejeon.guseong-family.workers.dev) → Manage site의 스니펫 속 token 값.
 *  페이지 HTML에 그대로 실리는 값이라 비밀값이 아니다. 비우면 비컨을 넣지 않는다. */
export const WEB_ANALYTICS_TOKEN = "00784247fdaf482a9a7f14ac7e177d73";

export const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";

const ENABLED_MODE = "deploy-production";

export function webAnalytics() {
  let enabled = false;
  return {
    name: "naejeon:web-analytics",
    apply: "build",
    config(_config, { mode }) {
      enabled = mode === ENABLED_MODE && WEB_ANALYTICS_TOKEN !== "";
      // 처리방침 화면이 켜졌는지 알 수 있게 한다.
      return { define: { "import.meta.env.VITE_WEB_ANALYTICS": JSON.stringify(enabled) } };
    },
    transformIndexHtml() {
      if (!enabled) return [];
      return [
        {
          tag: "script",
          attrs: { type: "module", src: BEACON_SRC, "data-cf-beacon": JSON.stringify({ token: WEB_ANALYTICS_TOKEN }) },
          injectTo: "body",
        },
      ];
    },
  };
}
