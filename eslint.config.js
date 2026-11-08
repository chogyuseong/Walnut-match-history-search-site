// 코드 검사(ESLint flat config). 서식은 검사하지 않는다(Prettier 없음).
//
// 왜 TypeScript를 바꿔 끼우나: 이 프로젝트의 타입 검사는 TypeScript 7(네이티브 tsc)이다. TypeScript 7 패키지는
// 예전 JS API(createSourceFile 등)를 내보내지 않아 typescript-eslint가 TS 코드를 읽지 못한다(지원 범위 <6.1).
// 그래서 package.json에 typescript-for-eslint(= typescript@5.9.3 별칭)를 두고, typescript-eslint 쪽 모듈이
// require("typescript")를 할 때만 그 별칭으로 돌린다. 타입 정보를 쓰지 않는 규칙만 켜므로 버전 차이는 문법 읽기뿐이다.
// typescript-eslint가 TypeScript 7을 지원하면 이 부분과 package.json의 overrides·별칭을 지운다.
import Module, { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const TS_FOR_ESLINT = require.resolve("typescript-for-eslint");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "typescript" && parent?.filename && /[\\/]node_modules[\\/](@typescript-eslint|typescript-eslint|ts-api-utils)[\\/]/.test(parent.filename)) {
    return TS_FOR_ESLINT;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

const { default: js } = await import("@eslint/js");
const { default: tseslint } = await import("typescript-eslint");
const { default: reactHooks } = await import("eslint-plugin-react-hooks");
const { default: globals } = await import("globals");

export default tseslint.config(
  {
    // 마지막 둘: 작업 중에 잠깐 만드는 임시 파일(*.tmp.*, __*.mjs 세션 임시 스크립트). .gitignore와 같다.
    ignores: ["dist/**", ".wrangler/**", "node_modules/**", "test-results/**", "playwright-report/**", "**/*.tmp.*", "**/__*.mjs"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 화면 코드: 브라우저 전역 + React 훅 규칙.
    files: ["src/web/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // 서버(Workers)·공용 로직·테스트·도구 스크립트.
    files: ["src/server/**/*.ts", "src/shared/**/*.ts", "test/**/*.ts", "e2e/**/*.ts", "*.config.ts"],
    languageOptions: { globals: { ...globals.worker, ...globals.node } },
  },
  {
    files: ["scripts/**/*.mjs", "*.js"],
    languageOptions: { globals: globals.node },
  },
  {
    rules: {
      // 기존 코드가 응답 JSON 등에 any를 의도적으로 쓴다. 새로 늘지 않게 경고로만 본다.
      "@typescript-eslint/no-explicit-any": "warn",
      // `_`로 시작하는 이름은 일부러 안 쓰는 값이다.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
);
