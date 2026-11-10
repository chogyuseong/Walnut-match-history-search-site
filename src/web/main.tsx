// 로그인에서 돌아온 경우 주소를 먼저 바꾼다(다른 모듈보다 먼저 불러온다).
import "./loginReturn";
// 지나온 화면 기록과 화면이 바뀔 때 맨 위로 올리기(nav.ts)는 첫 주소부터 지켜봐야 한다. "← 뒤로"를 그리는
// screenKit.tsx는 화면과 함께 늦게 받으므로, 거기서만 부르면 그 전에 옮겨 간 주소를 놓친다.
import "./nav";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary, installErrorReporting } from "./errorReport";
import "./styles.css";
import { applyTheme, readTheme } from "./theme";

// 첫 화면을 그리기 전에 기억해 둔 테마를 적용한다.
applyTheme(readTheme());
// 화면 오류를 서버 오류 기록으로 보낸다(src/web/errorReport.tsx).
installErrorReporting();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
