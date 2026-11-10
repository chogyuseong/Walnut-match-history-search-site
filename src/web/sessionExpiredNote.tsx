import { Suspense, useState } from "react";
import { LoginDialog, prefetchLogin } from "./lazyScreens";

// 오류 문구(ui.tsx ErrorNote)가 첫 화면 묶음에 있어 이 안내도 그 묶음에 실린다. 그래서 screens/Login.tsx에서 떼어 냈고,
// 로그인 창은 지연 로딩 조각으로 연다(누르기 전 버튼에 포인터·초점이 가면 미리 받는다).

/**
 * 저장하려는데 로그인이 만료됐을 때(401) 오류 안내 안에 두는 [다시 로그인]. 로그인 창을 이 자리에서 열고,
 * 입력 중인 내용은 건드리지 않는다. 로그인한 뒤 같은 버튼을 다시 누르면 된다.
 */
export function SessionExpiredNote() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="note warn" role="alert">
        로그인이 만료됐어요. 입력은 그대로 있어요. 다시 로그인한 뒤 한 번 더 저장해 주세요.{" "}
        <button
          type="button"
          className="link"
          onPointerEnter={prefetchLogin}
          onFocus={prefetchLogin}
          onClick={() => setOpen(true)}
        >
          다시 로그인
        </button>
      </p>
      {open && (
        <Suspense fallback={null}>
          <LoginDialog
            reason="로그인이 만료됐어요. 다시 로그인하면 이어서 저장할 수 있어요."
            onDone={() => setOpen(false)}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
