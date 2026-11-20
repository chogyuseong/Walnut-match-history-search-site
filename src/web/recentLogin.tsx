/**
 * 되돌리기 어려운 작업(모임 삭제·운영자 넘기기·같은 모임 복원·탈퇴) 앞의 "최근 로그인" 안내. 카카오·Google 계정에만 그린다.
 * 서버(src/server/routeKit.ts confirmIdentity)는 이 사이트에 로그인한 지 10분이 지난 세션을 403 REAUTH_REQUIRED로 거절한다.
 * 세션 쿠키만 훔친 사람은 제공자 로그인을 다시 거칠 수 없어서 이 작업들을 못 한다. 자체 계정은 이 자리에 비밀번호 칸이 나온다.
 * 쓰는 화면: screens/DangerZone.tsx, screens/Group.tsx(넘기기 창), screens/Restore.tsx.
 */
import { useEffect, useState } from "react";
import { ApiFailure } from "./api";
import { loginStartUrl, rememberCurrentScreen } from "./loginReturn";
import type { Me } from "./useApp";

const PROVIDER_LABEL = { kakao: "카카오", google: "Google" } as const;

/** 서버가 최근 로그인이 필요하다고 거절한 오류인지. 이 오류는 RecentLoginNote가 안내하므로 ErrorNote에는 넘기지 않는다. */
export function isReauthError(error: unknown): boolean {
  return error instanceof ApiFailure && error.code === "REAUTH_REQUIRED";
}

/** 다시 로그인해야 하는지(카카오·Google 세션만). 서버가 거절했거나, /api/me가 알려 준 기한이 지났거나 없으면 true. */
function needsRecentLogin(me: Me, error: unknown, now: number): boolean {
  if (isReauthError(error)) return true;
  const until = me.recentLoginUntil ? Date.parse(me.recentLoginUntil) : NaN;
  return !(until > now);
}

/**
 * 최근 로그인 상태. blocked면 실행 버튼을 막는다(어차피 서버가 거절하니 백업 내려받기 같은 앞 단계를 헛돌지 않게).
 * 기한이 지나는 순간 다시 그려 안내로 바뀌게 한다.
 */
export function useRecentLogin(me: Me | null, error: unknown): { applies: boolean; blocked: boolean } {
  const [now, setNow] = useState(() => Date.now());
  const until = me?.recentLoginUntil ? Date.parse(me.recentLoginUntil) : NaN;
  useEffect(() => {
    if (!(until > now)) return;
    const timer = setTimeout(() => setNow(Date.now()), until - now + 1000);
    return () => clearTimeout(timer);
  }, [until, now]);
  const applies = me?.loginMethod === "oauth" && me.provider !== undefined;
  return { applies, blocked: applies && needsRecentLogin(me!, error, now) };
}

/**
 * 안내 한 덩어리. 다시 로그인하면 지금 화면으로 돌아온다(loginReturn.ts). 입력하던 확인 문구·고른 파일은 남지 않으므로
 * 부르는 쪽이 필요하면 afterLogin으로 한 줄 덧붙인다.
 */
export function RecentLoginNote(props: { me: Me | null; blocked: boolean; afterLogin?: string }) {
  const provider = props.me?.provider;
  if (props.me?.loginMethod !== "oauth" || !provider) return null;
  const label = PROVIDER_LABEL[provider];
  if (!props.blocked) {
    const until = new Date(props.me.recentLoginUntil!).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    return <p className="hint">방금 로그인을 확인했어요. {until}까지 이 작업을 할 수 있어요.</p>;
  }
  return (
    <div className="note" role="note">
      <p>
        안전을 위해 이 작업은 로그인한 지 10분 안에만 할 수 있어요. {label}로 다시 로그인하면 이 화면으로 돌아와요.
        {props.afterLogin ? ` ${props.afterLogin}` : ""}
      </p>
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            rememberCurrentScreen();
            location.assign(loginStartUrl(provider, true));
          }}
        >
          {label}로 다시 로그인
        </button>
      </div>
    </div>
  );
}
