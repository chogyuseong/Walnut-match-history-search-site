// 검색 노출(색인) 설정. vite.config.ts가 빌드 때만 쓴다.
//
// 운영 빌드(`vite build --mode deploy-production`, npm run deploy:production)만 첫 화면("/")을 검색엔진에 연다.
// staging·로컬·모드를 주지 않은 vite build는 막아 둔다. staging도 운영과 같은 화면이라 둘 다 열면 같은 사이트가 두 번 잡힌다.
// 런타임 값으로는 나눌 수 없어서(staging도 DEPLOY_ENV가 "production") 빌드 때 정한다. index.html·robots.txt는
// Worker를 거치지 않는 정적 파일이다(wrangler.jsonc run_worker_first는 /api/*뿐).
//
//   막을 때: index.html의 noindex 메타를 그대로 두고, _headers 끝에 X-Robots-Tag: noindex를 붙인다. robots.txt는 열어 둔다.
//            robots.txt로 막으면 검색엔진이 페이지를 받지 않아 noindex를 못 읽고, 링크만 보고 주소를 결과에 올릴 수 있다.
//   열 때:   noindex 메타를 지우고, robots.txt는 /api/만 막고 sitemap.xml("/" 하나)을 알린다.
//
// 화면 주소는 해시 방식(#/v/토큰 등)이라 검색엔진이 보는 페이지는 "/" 하나다. 모임 기록·토큰 링크는 따로 잡히지 않는다.
// canonical·og:url은 빌드와 상관없이 운영 주소로 고정한다(staging 주소가 공유돼도 운영을 가리키게).
// 운영 주소를 바꾸면(도메인 연결 등) SITE_ORIGIN 한 곳만 고친다.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export const SITE_ORIGIN = "https://naejeon.guseong-family.workers.dev";

/** package.json deploy:production이 넘기는 vite 모드. 이 모드일 때만 색인을 연다. */
export const INDEXED_MODE = "deploy-production";

/** src/web/index.html에 적어 둔 그대로여야 지울 수 있다. 문구를 바꾸면 여기도 바꾼다. */
const NOINDEX_META = /\n\s*<meta name="robots" content="noindex" \/>/;

const ROBOTS_NO_SITEMAP = "User-agent: *\nAllow: /\n";

const ROBOTS_OPEN = `User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${SITE_ORIGIN}/sitemap.xml
`;

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE_ORIGIN}/</loc></url>
</urlset>
`;

// Cloudflare _headers는 한 주소에 맞는 규칙들의 헤더를 모두 붙인다. 기존 /* 규칙은 건드리지 않고 규칙을 하나 더 단다.
const HEADERS_BLOCKED = `
# 검색 차단 빌드(운영이 아닌 빌드)에서만 붙는 규칙. scripts/search-index-plugin.mjs가 빌드 때 덧붙인다.
/*
  X-Robots-Tag: noindex
`;

export function searchIndex() {
  let indexed = false;
  return {
    name: "naejeon:search-index",
    apply: "build",
    configResolved(config) {
      indexed = config.mode === INDEXED_MODE;
    },
    transformIndexHtml(html) {
      if (indexed && !NOINDEX_META.test(html)) {
        // 메타 문구가 바뀌어 못 지우면 운영이 조용히 검색에서 빠진 채 배포된다. 빌드를 멈춰 알린다.
        throw new Error("index.html에서 noindex 메타를 찾지 못했어요. scripts/search-index-plugin.mjs NOINDEX_META를 맞춰 주세요.");
      }
      return {
        html: indexed ? html.replace(NOINDEX_META, "") : html,
        tags: [
          { tag: "link", attrs: { rel: "canonical", href: `${SITE_ORIGIN}/` }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:url", content: `${SITE_ORIGIN}/` }, injectTo: "head" },
        ],
      };
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "robots.txt", source: indexed ? ROBOTS_OPEN : ROBOTS_NO_SITEMAP });
      if (indexed) this.emitFile({ type: "asset", fileName: "sitemap.xml", source: SITEMAP });
    },
    // public/_headers는 vite가 그대로 복사하므로, 복사된 결과 파일 끝에 덧붙인다.
    writeBundle(options) {
      if (!indexed) appendFileSync(join(options.dir, "_headers"), HEADERS_BLOCKED, "utf8");
    },
  };
}
