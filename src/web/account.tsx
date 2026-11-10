import { Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoginDialog, prefetchLogin } from "./lazyScreens";
import { ErrorNote } from "./ui";
import { go, useAppValue } from "./useApp";

/** 로그인한 운영자만 쓰는 화면(주소의 첫 칸). 로그인하지 않았으면 로그인 안내를 대신 보여준다. */
export const LOGIN_ONLY: Record<string, string> = {
  group: "모임",
  import: "표 일괄 입력",
  "sheet-import": "구글 시트에서 가져오기",
  "legacy-import": "기존 사이트 기록 가져오기",
  backfill: "지난 경기 입력",
  merge: "중복 참가자 합치기",
  dates: "날짜 점검",
  priority: "티어 배정",
  delete: "모임 삭제 · 탈퇴",
  // 참가자로 연결한 모임의 읽기 전용 화면(src/web/screens/Member.tsx).
  mine: "참가 중인 모임",
};

/** 운영자 역할 이름. 상단 바의 모임 바꾸기 메뉴와 모임 탭(groupSwitcher.tsx)이 같이 쓴다. */
export const ROLE_LABEL = { owner: "대표", co: "공동 운영자" } as const;

/**
 * 로그인 창. 상단 바 안(넓은 화면에서 흐림 효과가 걸린 고정 바)에 그리면 창이 바 안에 갇히므로
 * 문서 맨 끝에 그린다. 창 코드는 지연 로딩이라(lazyScreens.ts) 받는 동안은 아무것도 그리지 않는다.
 */
function LoginDialogOnBody(props: { reason: string; onClose: () => void }) {
  return createPortal(
    <Suspense fallback={null}>
      <LoginDialog reason={props.reason} onDone={props.onClose} onClose={props.onClose} />
    </Suspense>,
    document.body,
  );
}

/**
 * 상단 바의 로그인 상태. 로그인 전에는 [로그인], 로그인 뒤에는 [로그인됨]을 누르면 로그아웃이 나온다.
 * 계정 식별자·이름은 그리지 않는다(서버도 로그인 수단의 고유 번호만 저장한다).
 */
export function AccountControl() {
  const app = useAppValue();
  const [loginOpen, setLoginOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const loggedIn = Boolean(app.me?.accountId);

  // 메뉴 밖을 누르거나 Esc를 누르면 닫는다. Esc로 닫으면 초점을 [로그인됨]으로 돌려준다.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // 로그아웃·로그인 만료로 상태가 바뀌면 메뉴를 닫는다.
  useEffect(() => {
    if (!loggedIn) setMenuOpen(false);
  }, [loggedIn]);

  // 계정 상태를 아직 모르면(첫 불러오기 중) 아무것도 그리지 않는다. 잠깐 [로그인]이 보였다 사라지지 않게.
  if (!app.ready) return null;

  if (!loggedIn) {
    return (
      <>
        {/* 상단 바 버튼은 secondary: 화면마다 주 버튼(primary)은 본문의 하나뿐이다(2026-11-08 화면 점검). */}
        <button
          type="button"
          className="secondary topbar-login"
          onPointerEnter={prefetchLogin}
          onFocus={prefetchLogin}
          onClick={() => setLoginOpen(true)}
        >
          로그인
        </button>
        {loginOpen && (
          <LoginDialogOnBody
            reason="로그인하면 저장된 모임과 기록을 불러오고, 모임 탭에서 시트 가져오기·백업 같은 운영 기능을 쓸 수 있어요."
            onClose={() => setLoginOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <div className="topbar-account" ref={wrap}>
      <button
        ref={toggle}
        type="button"
        className="secondary topbar-account-button"
        aria-expanded={menuOpen}
        aria-controls="account-menu"
        onClick={() => {
          setError(null);
          setMenuOpen((open) => !open);
        }}
      >
        <span className="account-dot" aria-hidden="true" />
        로그인됨
      </button>
      {menuOpen && (
        <div id="account-menu" className="account-menu" role="group" aria-label="로그인 상태">
          <p>이 기기에서 운영자로 로그인돼 있어요.</p>
          {(app.me?.groups.length ?? 0) > 1 && (
            <div className="account-groups" role="group" aria-label="모임 바꾸기">
              {app.me!.groups.map((g) => {
                const label =
                  g.id === app.snapshot?.group.id ? app.snapshot.group.name : g.name;
                return (
                  <button
                    key={g.id}
                    type="button"
                    className="secondary wide"
                    aria-pressed={g.id === app.groupId}
                    disabled={app.switching}
                    onClick={() => {
                      setMenuOpen(false);
                      if (g.id === app.groupId) return;
                      void app.switchGroup(g.id).then(() => app.setNotice(`'${label}' 모임으로 바꿨어요.`));
                    }}
                  >
                    {label} · {ROLE_LABEL[g.role ?? "owner"]}
                  </button>
                );
              })}
            </div>
          )}
          {(app.me?.memberships?.length ?? 0) > 0 && (
            // 참가자로 연결한 모임(migrations/0019). 고르면 조회 링크와 같은 읽기 전용 화면이 열린다.
            <div className="account-groups" role="group" aria-label="참가 중인 모임">
              {app.me!.memberships!.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="secondary wide"
                  onClick={() => {
                    setMenuOpen(false);
                    go(`/mine/${m.id}`);
                  }}
                >
                  {m.name} · 참가 중({m.participantName})
                </button>
              ))}
            </div>
          )}
          {app.me?.siteAdmin && (
            // 사이트 운영자(서비스 주인)에게만 보인다. 모임 운영자 권한과 무관하다.
            <button
              type="button"
              className="secondary wide"
              onClick={() => {
                setMenuOpen(false);
                go("/admin");
              }}
            >
              사이트 현황
            </button>
          )}
          <ErrorNote error={error} />
          <button
            type="button"
            className="secondary wide"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              const page = location.hash.replace(/^#\/?/, "").split("/")[0] ?? "";
              void app
                .logout()
                .then(() => {
                  setMenuOpen(false);
                  app.setNotice("로그아웃했어요. 작성 중인 편성은 이 기기에 남아 있어요.");
                  // 로그인해야 쓰는 화면에 있었다면 첫 화면으로 간다.
                  if (page in LOGIN_ONLY) go("/");
                })
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "로그아웃 중" : "로그아웃"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 로그인해야 쓰는 화면에 로그인하지 않고 들어왔을 때. 로그인하면 같은 주소이므로 그 화면이 그대로 열린다
 * (카카오·Google 로그인도 누른 순간의 주소로 돌아온다).
 */
export function LoginRequired(props: { title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="screen">
      <h1>{props.title}</h1>
      <p className="note">이 화면은 로그인이 필요해요. 로그인하면 이 화면이 바로 열려요.</p>
      <p className="hint">팀 짜기와 명단 복사는 로그인 없이 됩니다.</p>
      <div className="button-row">
        <button
          type="button"
          className="primary"
          onPointerEnter={prefetchLogin}
          onFocus={prefetchLogin}
          onClick={() => setOpen(true)}
        >
          로그인하고 계속
        </button>
        <button type="button" className="secondary" onClick={() => go("/")}>
          오늘로 가기
        </button>
      </div>
      {open && (
        <Suspense fallback={null}>
          <LoginDialog
            reason={`'${props.title}' 화면은 모임을 운영하는 계정으로 로그인해야 열려요.`}
            onDone={() => setOpen(false)}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

/**
 * 모임이 아직 없는 계정에게 모임을 먼저 만들고 그 화면으로 가게 하는 버튼.
 * 경기를 한 번도 하지 않고 지난 기록부터 넣고 싶은 사람을 위한 길이다. 모임 만들기는 app.ensureGroup을 쓴다.
 */
export function CreateGroupButton(props: { label: string; to: string; primary?: boolean }) {
  const app = useAppValue();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <button
        type="button"
        className={props.primary ? "primary" : "secondary"}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void app
            .ensureGroup()
            .then(() => {
              app.setNotice("모임을 만들었어요. 모임 이름은 모임 탭에서 바꿀 수 있어요.");
              go(props.to);
            })
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      >
        {busy ? "모임 만드는 중…" : props.label}
      </button>
      <ErrorNote error={error} />
    </>
  );
}
