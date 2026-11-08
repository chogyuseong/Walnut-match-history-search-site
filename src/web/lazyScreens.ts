import { createElement, lazy, useState, type ComponentProps, type ComponentType, type ElementType } from "react";

/**
 * 화면 단위 코드 분할. 첫 화면 묶음(main.tsx → App.tsx)에는 껍데기(상단 바·탭·로그인 창·상태 훅)만 두고
 * 화면은 처음 열 때 받는다. 묶음 기준:
 *  (가) 로그인 없이 여는 공개 화면: 참가 신청·조회 링크·참가자 편성(조회 링크의 /live)·예시 모임·개인정보 처리방침 — 화면마다 따로.
 *  (나) 운영자 기본 흐름: 오늘(첫 화면)은 따로, 나머지(고르기·준비·경기·모임·기록·개인 등)는 한 덩어리(screens/operator.ts).
 *  (다) 무거운 드문 화면: 가져오기·과거 기록·합치기·사이트 현황·그래프·시즌 요약·비교 — 화면마다 따로.
 * 같은 모듈을 여러 묶음이 쓰면 번들러가 공용 조각으로 뺀다(예: 조회 링크와 운영자 기록이 같이 쓰는 Records).
 */

/** 이미 받은 화면 모듈(불러오기 함수 → 모듈). 미리 받기(preload)와 React.lazy가 함께 채운다. */
const loadedModules = new Map<() => Promise<unknown>, unknown>();

/** 화면 모듈을 미리 받는다. 받은 뒤 그 모듈의 화면은 처음 열 때도 "불러오는 중…" 없이 바로 그려진다. */
export function preload<M>(load: () => Promise<M>): Promise<M> {
  return load().then((m) => {
    loadedModules.set(load, m);
    return m;
  });
}

/**
 * 모듈의 이름 있는 내보내기 하나를 지연 로딩 화면으로 바꾼다.
 * React.lazy는 모듈을 이미 받았어도 그 컴포넌트를 처음 그릴 때 한 번 멈추고(대체 화면), React가 대체 화면을
 * 잠시(약 300ms) 유지한다. 그래서 이미 받은 모듈이면 lazy를 거치지 않고 실제 화면을 바로 그린다.
 * 어느 쪽을 쓸지는 화면을 처음 그릴 때 정하고 그 뒤로 바꾸지 않는다(바꾸면 화면이 새로 만들어져 입력 상태가 사라진다).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 화면마다 props가 달라 컴포넌트 타입을 일반화한다.
function lazyNamed<M extends Record<K, ComponentType<any>>, K extends keyof M>(load: () => Promise<M>, key: K) {
  type Props = ComponentProps<M[K]>;
  const Lazy = lazy(async () => {
    const m = await load();
    loadedModules.set(load, m);
    return { default: m[key] as ComponentType<Props> };
  });
  function LazyScreen(props: Props) {
    const [Component] = useState<ElementType<Props>>(
      () => ((loadedModules.get(load) as M | undefined)?.[key] as ComponentType<Props> | undefined) ?? Lazy,
    );
    return createElement(Component, props);
  }
  LazyScreen.displayName = `Lazy(${String(key)})`;
  return LazyScreen;
}

// (가) 공개 화면
export const Join = lazyNamed(() => import("./screens/Join"), "Join");
export const Viewer = lazyNamed(() => import("./screens/Viewer"), "Viewer");
/** 참가자 편성 화면(#/v/토큰/live). 조회 화면 묶음(기록·통계 포함)과 따로 작게 받는다. */
export const ViewerLive = lazyNamed(() => import("./screens/ViewerLive"), "ViewerLive");
export const Demo = lazyNamed(() => import("./screens/Demo"), "Demo");
export const Privacy = lazyNamed(() => import("./screens/Privacy"), "Privacy");

// (나) 운영자 기본 흐름
export const Today = lazyNamed(() => import("./screens/Today"), "Today");
/** 운영자 화면 묶음. 미리 받기(prefetch)와 각 화면이 같은 import()를 쓰므로 한 번만 받는다. */
export const loadOperatorScreens = () => import("./screens/operator");
export const Pick = lazyNamed(loadOperatorScreens, "Pick");
export const Prep = lazyNamed(loadOperatorScreens, "Prep");
export const Match = lazyNamed(loadOperatorScreens, "Match");
export const Group = lazyNamed(loadOperatorScreens, "Group");
export const PriorityScreen = lazyNamed(loadOperatorScreens, "PriorityScreen");
export const Search = lazyNamed(loadOperatorScreens, "Search");
export const Transfer = lazyNamed(loadOperatorScreens, "Transfer");
export const CoInvite = lazyNamed(loadOperatorScreens, "CoInvite");
export const Claim = lazyNamed(loadOperatorScreens, "Claim");
export const Member = lazyNamed(loadOperatorScreens, "Member");
export const OperatorRecords = lazyNamed(loadOperatorScreens, "OperatorRecords");
export const MatchDetail = lazyNamed(loadOperatorScreens, "MatchDetail");
export const Person = lazyNamed(loadOperatorScreens, "Person");
export const DangerZone = lazyNamed(loadOperatorScreens, "DangerZone");

// (다) 무거운 드문 화면
export const Import = lazyNamed(() => import("./screens/Import"), "Import");
export const SheetImport = lazyNamed(() => import("./screens/SheetImport"), "SheetImport");
export const LegacyImport = lazyNamed(() => import("./screens/LegacyImport"), "LegacyImport");
export const Backfill = lazyNamed(() => import("./screens/Backfill"), "Backfill");
export const Merge = lazyNamed(() => import("./screens/Merge"), "Merge");
export const SiteAdmin = lazyNamed(() => import("./screens/SiteAdmin"), "SiteAdmin");
export const Graphs = lazyNamed(() => import("./screens/Graphs"), "Graphs");
export const SeasonSummaryScreen = lazyNamed(() => import("./screens/SeasonSummary"), "SeasonSummaryScreen");
export const Compare = lazyNamed(() => import("./screens/Compare"), "Compare");
