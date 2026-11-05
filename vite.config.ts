import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 화면은 정적 파일로 빌드해 Worker와 함께 배포한다. 서버 렌더링은 쓰지 않는다.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    // 개발 중에는 API 요청을 로컬 Worker(wrangler dev)로 넘긴다.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
