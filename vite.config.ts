import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 화면은 정적 파일로 빌드해 Worker와 함께 배포한다. 서버 렌더링은 쓰지 않는다.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  // 저장소 맨 위 public/(정적 헤더 파일 _headers 등)을 빌드 결과(dist/web)에 그대로 복사한다.
  publicDir: "../../public",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // 화면은 src/web/lazyScreens.ts에서 화면 단위로 나눈다. 여기서는 React를 따로 떼어
        // 화면 코드가 바뀌어도 브라우저 캐시에 남은 React 조각을 다시 받지 않게 한다.
        codeSplitting: {
          groups: [{ name: "vendor-react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ }],
        },
      },
    },
  },
  server: {
    // 개발 중에는 API 요청을 로컬 Worker(wrangler dev)로 넘긴다.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
