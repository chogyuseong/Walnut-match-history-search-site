// 주소 기반 미리 받기(vite.config.ts가 빌드 때만 쓴다).
//
// 조회 링크·참가 신청·예시 모임으로 처음 들어온 사람은 진입 JS(React 포함)를 다 받고 실행한 뒤에야 화면 조각을 요청한다.
// 그 기다림을 줄이려고, 빌드가 끝날 때 "주소 → 화면 조각 파일" 대응표를 담은 작은 JS를 /assets/ 아래 해시 이름으로 내보내고
// index.html의 진입 스크립트 앞에 <script type="module" src>로 단다. 그 파일은 location.hash를 보고 해당 조각에
// <link rel="modulepreload">를 붙인다. 진입 JS보다 먼저 실행되므로 React를 받는 동안 화면 조각도 함께 받는다.
//
// - 보안 정책이 script-src 'self'라(public/_headers, src/server/http.ts) 인라인 스크립트로 넣지 않는다. 같은 출처의 파일이다.
// - 미리 받기는 최적화일 뿐이다. 이 파일이 없거나 대응이 틀려도 화면은 lazyScreens.ts의 import()로 평소처럼 뜬다.
// - 주소 규칙은 App.tsx의 화면 고르기(useRoute → stripRouteQuery → isViewer·isJoin·isDemo)와 맞춘다. 거기를 바꾸면 여기도 바꾼다.
// - #/(오늘 화면)는 넣지 않는다. 2026-11-10 측정(scripts/measure-load.mjs)에서 오늘 조각(13개 파일)을 여기서 미리 받으면
//   화면 조각 표시가 오히려 약 0.5초 늦었다(2.3초 → 2.8초, 3회씩 같은 경향). 운영자 묶음은 App.tsx usePrefetchOperator가 맡는다.
// - 대응표가 가리키는 파일이 빌드 결과에 있는지는 scripts/check-bundle.mjs가 다시 확인한다(ROUTE_CHUNKS 줄을 읽는다).

/** 대응표 이름 → 그 주소에서 여는 화면 모듈(lazyScreens.ts의 import() 대상). */
const ROUTE_MODULES = {
  viewer: "src/web/screens/Viewer.tsx",
  viewerLive: "src/web/screens/ViewerLive.tsx",
  join: "src/web/screens/Join.tsx",
  demo: "src/web/screens/Demo.tsx",
};

/** check-bundle.mjs가 이 이름으로 찾는다. */
export const ROUTE_PRELOAD_NAME = "route-preload";

/** 브라우저에서 도는 부분. ROUTE_CHUNKS는 빌드 때 채운다. 한 줄 JSON이어야 check-bundle.mjs가 읽는다. */
function preloadScript(table) {
  return `// 빌드가 만든 파일(scripts/route-preload-plugin.mjs). 주소를 보고 그 화면 조각을 미리 받는다.
const ROUTE_CHUNKS = ${JSON.stringify(table)};
const route = location.hash.replace(/^#\\/?/, "").split("?")[0].split("/").filter((part) => part !== "");
const key =
  route[0] === "v" && route[1] ? (route[2] === "live" ? "viewerLive" : "viewer")
  : route[0] === "join" && route[1] ? "join"
  : route[0] === "demo" ? "demo"
  : null;
for (const file of (key && ROUTE_CHUNKS[key]) || []) {
  const link = document.createElement("link");
  link.rel = "modulepreload";
  // 진입 스크립트와 같은 요청 방식(crossorigin)이어야 import() 때 받은 것을 다시 쓴다.
  link.crossOrigin = "";
  link.href = "/assets/" + file;
  document.head.appendChild(link);
}
`;
}

export function routePreload() {
  return {
    name: "naejeon:route-preload",
    apply: "build",
    // index.html 자산은 Vite의 html 플러그인이 generateBundle에서 만든다. 그 뒤에 고쳐야 하므로 post.
    enforce: "post",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
      const norm = (id) => id.replaceAll("\\", "/");
      const entry = chunks.find((c) => c.isEntry);
      if (!entry) this.error("진입 조각을 찾지 못했어요.");

      // 첫 화면에서 이미 받는 파일(진입 + 정적 import)은 대응표에서 뺀다.
      const byName = new Map(chunks.map((c) => [c.fileName, c]));
      const closure = (start) => {
        const seen = new Set();
        const stack = [start];
        while (stack.length > 0) {
          const name = stack.pop();
          if (seen.has(name)) continue;
          seen.add(name);
          for (const dep of byName.get(name)?.imports ?? []) stack.push(dep);
        }
        return seen;
      };
      const initial = closure(entry.fileName);

      const table = {};
      for (const [key, module] of Object.entries(ROUTE_MODULES)) {
        // 화면 모듈이 들어 있는 조각. 공용 조각과 합쳐지면 facadeModuleId가 비므로 담긴 모듈 목록으로 찾는다.
        const chunk = chunks.find((c) => c.moduleIds.some((id) => norm(id).endsWith(module)));
        // 화면을 옮기거나 이름을 바꿨는데 여기를 안 고쳤으면 빌드를 멈춘다(조용히 미리 받기가 꺼지지 않게).
        if (!chunk) this.error(`주소 미리 받기: ${module}의 조각을 찾지 못했어요. ROUTE_MODULES를 고쳐 주세요.`);
        table[key] = [...closure(chunk.fileName)].filter((f) => !initial.has(f)).map((f) => f.replace(/^assets\//, ""));
      }

      const ref = this.emitFile({ type: "asset", name: `${ROUTE_PRELOAD_NAME}.js`, source: preloadScript(table) });
      const fileName = this.getFileName(ref);
      const html = bundle["index.html"];
      if (!html || html.type !== "asset") this.error("index.html을 찾지 못했어요.");
      const source = String(html.source);
      const entryTag = source.match(/<script type="module"[^>]*src="\/assets\/[^"]+\.js"[^>]*><\/script>/);
      if (!entryTag) this.error("index.html에서 진입 스크립트 태그를 찾지 못했어요.");
      // 진입 스크립트 바로 앞: 모듈 스크립트는 문서 순서대로 실행되므로 진입 JS보다 먼저 돈다.
      html.source = source.replace(
        entryTag[0],
        `<script type="module" crossorigin src="/${fileName}"></script>\n    ${entryTag[0]}`,
      );
    },
  };
}
