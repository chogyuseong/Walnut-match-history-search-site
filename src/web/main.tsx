// 로그인에서 돌아온 경우 주소를 먼저 바꾼다(다른 모듈보다 먼저 불러온다).
import "./loginReturn";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { applyTheme, readTheme } from "./theme";

// 첫 화면을 그리기 전에 기억해 둔 테마를 적용한다.
applyTheme(readTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
