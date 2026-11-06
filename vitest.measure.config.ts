import { defineConfig } from "vitest/config";

// 운영자 스냅숏 크기·통계 계산 시간 측정(test/measure). Node에서 돌고 로컬 서버(npm run dev, 127.0.0.1:8787)를 부른다.
// 실행: 다른 창에서 npm run dev → npx vitest run --config vitest.measure.config.ts --silent=false (결과 표는 콘솔 출력)
// 기본 테스트(npm test)에는 들어가지 않는다.
export default defineConfig({
  test: {
    include: ["test/measure/**/*.measure.ts"],
    environment: "node",
  },
});
