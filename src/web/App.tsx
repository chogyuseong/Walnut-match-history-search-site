import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { AccountControl, LOGIN_ONLY, LoginRequired } from "./account";
import {
  Backfill,
  ChampionTier,
  Claim,
  CoInvite,
  Compare,
  DangerZone,
  Demo,
  Graphs,
  Group,
  Import,
  Join,
  LegacyImport,
  loadOperatorScreens,
  LoginFailed,
  Match,
  MatchDetail,
  Member,
  DateCheck,
  Merge,
  OperatorRecords,
  Person,
  Pick,
  Prep,
  preload,
  Ranking,
  PriorityScreen,
  Privacy,
  Search,
  SeasonSummaryScreen,
  SheetImport,
  SiteAdmin,
  Today,
  Transfer,
  Viewer,
  ViewerLive,
} from "./lazyScreens";
import { CHAMPION_PORTRAITS } from "./portraits";
import { stripRouteQuery, useSearchShortcut } from "./searchRoute";
import { seasonRoutePart, seasonScopeFromRoute } from "./seasonRoute";
import { applyTheme, readTheme, THEMES, type Theme } from "./theme";
import { LineIcon, useKeyboardFlag, type LineIconName } from "./ui";
import { AppContext, go, useApp, useAppValue, useRoute, type AppValue } from "./useApp";

/** 화면 코드를 받는 동안 보여 주는 표시. 모임 기록을 받는 동안의 표시와 같다. */
const LOADING = <p className="screen">불러오는 중…</p>;

/**
 * 운영자 화면 묶음(src/web/screens/operator.ts)을 첫 화면을 그린 뒤 미리 받는다. 고르기·준비 화면으로 넘어갈 때
 * "불러오는 중…"이 깜빡이지 않게 한다. 로그인했거나 이 기기에 작성 중인 편성이 있을 때만(곧 쓸 사람) 받는다.
 */
function usePrefetchOperator(app: AppValue, enabled: boolean): void {
  const wanted = enabled && app.ready && (!!app.me?.accountId || app.draft !== null);
  useEffect(() => {
    if (!wanted) return;
    const timer = setTimeout(() => {
      // 미리 받기에 실패해도(오프라인 등) 화면을 열 때 다시 받는다.
      preload(loadOperatorScreens).catch(() => undefined);
    }, 0);
    return () => clearTimeout(timer);
  }, [wanted]);
}

export function App() {
  // 주소의 "?" 뒤(검색 질의 q=)는 화면 고르기에 쓰지 않는다. 검색 화면이 직접 읽는다(searchRoute.ts).
  const rawRoute = useRoute();
  const route = useMemo(() => stripRouteQuery(rawRoute), [rawRoute]);
  useSearchShortcut(route);
  const isViewer = route[0] === "v" && typeof route[1] === "string";
  // 참가 신청(#/join/토큰)도 로그인 없이 여는 화면이라 운영자 상태를 읽지 않는다.
  const isJoin = route[0] === "join" && typeof route[1] === "string";
  // 예시 모임(#/demo)은 기기에서 만든 합성 데이터만 보여 주므로 운영자 상태를 읽지 않는다.
  const isDemo = route[0] === "demo";
  const operatorMode = !isViewer && !isJoin && !isDemo;
  const app = useApp(operatorMode);
  useKeyboardFlag();
  usePrefetchOperator(app, operatorMode);
  useDocumentTitle(route, !!app.me?.accountId, !!app.me?.siteAdmin);

  if (isJoin) {
    return (
      <>
        <TopBar />
        <main tabIndex={-1}>
          <Suspense fallback={LOADING}>
            <Join token={route[1]!} rest={route.slice(2)} />
          </Suspense>
          <LegalFooter privacyHref={`#/join/${route[1]}/privacy`} />
        </main>
      </>
    );
  }

  if (isDemo) {
    return (
      <>
        <TopBar homeLink />
        {/* bleed: 예시 안내 띠·메뉴 줄의 바탕과 선이 창 폭 전체로 그어지게 main의 폭 제한을 풀고, 나머지는 .bleed-body가 1200px로 묶는다. */}
        <main className="bleed" tabIndex={-1}>
          <Suspense fallback={LOADING}>
            <Demo rest={route.slice(1)} />
          </Suspense>
          <div className="bleed-body">
            <LegalFooter />
          </div>
        </main>
      </>
    );
  }

  if (isViewer) {
    return (
      <>
        <TopBar />
        <main className="bleed" tabIndex={-1}>
          <Suspense fallback={LOADING}>
            {/* 참가자 편성(#/v/토큰/live)은 진행 중 편성만 보여 주는 작은 화면이라 조회 화면 묶음을 받지 않는다. */}
            {route[2] === "live" ? (
              <ViewerLive token={route[1]!} />
            ) : (
              <Viewer token={route[1]!} rest={route.slice(2)} />
            )}
          </Suspense>
          {/* 조회 링크로 들어온 사람은 처리방침을 보고도 조회 화면으로 돌아올 수 있게 같은 링크 아래에서 연다. */}
          <div className="bleed-body">
            <LegalFooter privacyHref={`#/v/${route[1]}/privacy`} />
          </div>
        </main>
      </>
    );
  }

  return (
    <AppContext.Provider value={app}>
      <TopBar homeLink actions={<AccountControl />} />
      {/* 참가 중인 모임(#/mine/...)은 자기 메뉴(조회 메뉴)를 쓴다. 운영 탭은 다른 모임을 가리키므로 숨긴다.
          <main> 앞에 둔다: 넓은 화면에서 상단 바 바로 아래 한 줄이고, Tab 순서도 상단 바 → 주 메뉴 → 본문이다.
          좁은 화면에서는 CSS가 아래에 고정한다(순서는 같다). */}
      {route[0] !== "mine" && <Tabs current={route[0] ?? ""} />}
      {/* 참가 중인 모임은 조회 메뉴 줄이 main 안에 있어, 예시·조회 링크처럼 main의 폭 제한을 풀고(bleed) 줄을 창 폭 전체로
          긋는다. 본문은 Member의 .bleed-body, 푸터는 아래 .bleed-body가 본문 폭으로 묶는다. */}
      <main className={route[0] === "mine" ? "bleed" : undefined} tabIndex={-1}>
        {!app.ready || app.switching ? (
          LOADING
        ) : (
          // 모임을 바꾸면 화면을 새로 그린다(앞 모임에서 입력하던 상태가 남지 않게).
          <Suspense fallback={LOADING}>
            <OperatorScreen key={app.switchSeq} route={route} />
          </Suspense>
        )}
        {route[0] === "mine" ? (
          <div className="bleed-body">
            <LegalFooter />
          </div>
        ) : (
          <LegalFooter />
        )}
      </main>
      {app.notice && (
        <p className="toast" role="status">
          {app.notice}
        </p>
      )}
    </AppContext.Provider>
  );
}

/** 사이트 이름. 상단 바와 푸터, 문서 제목이 함께 쓴다. */
const SITE_NAME = "내전로그";

/**
 * 운영 화면의 주소 첫 조각(route[0]) → 화면 이름. 문서 제목("화면 이름 · 내전로그")에 쓰고, 이 표에 없는 주소는
 * "없는 주소" 화면을 보여 준다. 새 화면을 OperatorScreen에 더하면 여기에도 더한다.
 * admin은 사이트 운영자가 아니면 오늘 화면을 보여 주므로(존재를 숨김) 제목도 그때는 "오늘"이다(pageTitle).
 */
const PAGE_TITLE: Record<string, string> = {
  "": "오늘",
  pick: "참가자 고르기",
  prep: "팀 짜기",
  priority: "티어 배정",
  match: "경기 진행",
  group: "모임",
  import: "표 일괄 입력",
  "sheet-import": "구글 시트에서 가져오기",
  "legacy-import": "기존 사이트 기록 가져오기",
  backfill: "지난 경기 입력",
  merge: "중복 참가자 합치기",
  dates: "날짜 점검",
  delete: "모임 삭제 · 탈퇴",
  search: "전적 검색",
  transfer: "운영자 넘겨받기",
  "co-invite": "공동 운영자 초대",
  claim: "참가자 연결",
  mine: "참가 중인 모임",
  records: "기록",
  m: "경기 상세",
  season: "시즌 요약",
  graphs: "그래프 분석",
  ranking: "MMR 랭킹",
  champions: "챔피언 티어",
  p: "개인 통계",
  compare: "두 사람 비교",
  privacy: "개인정보 처리방침",
  "login-failed": "로그인 실패",
  "login-return": "오늘",
  admin: "사이트 운영 현황",
};

/** 조회 링크·예시 모임 안의 하위 화면(rest[0]) → 화면 이름. 없거나 모르는 값은 각 화면의 첫 화면 이름을 쓴다. */
const SUB_PAGE_TITLE: Record<string, string> = {
  records: "기록",
  m: "경기 상세",
  season: "시즌 요약",
  graphs: "그래프 분석",
  ranking: "MMR 랭킹",
  champions: "챔피언 티어",
  p: "개인 통계",
  compare: "두 사람 비교",
  search: "전적 검색",
  privacy: "개인정보 처리방침",
  live: "참가자 편성",
};

/** 운영 화면 주소가 알려진 화면인지. */
function isKnownPage(page: string | undefined): boolean {
  return Object.prototype.hasOwnProperty.call(PAGE_TITLE, page ?? "");
}

/**
 * index.html의 <title>(검색 결과에 보이는 제목). 검색엔진도 화면을 그린 뒤의 제목을 읽으므로, 로그인하지 않은 첫 화면은
 * "오늘 · 내전로그"로 바꾸지 않고 이 제목을 둔다. 제목 문구는 index.html에서만 고친다.
 */
const SEARCH_TITLE = document.title;

/** 지금 주소의 문서 제목. 사람 이름 같은 동적 제목은 쓰지 않는다. */
function pageTitle(route: string[], loggedIn: boolean, siteAdmin: boolean): string {
  const [page = "", sub] = route;
  if (page === "" && !loggedIn) return SEARCH_TITLE;
  let name: string;
  if (page === "v" && route[1]) name = SUB_PAGE_TITLE[route[2] ?? ""] ?? "조회";
  else if (page === "join" && route[1]) name = route[2] === "privacy" ? "개인정보 처리방침" : "참가 신청";
  else if (page === "demo") name = SUB_PAGE_TITLE[sub ?? ""] ?? "예시 모임";
  else if (page === "admin" && !siteAdmin) name = PAGE_TITLE[""]!;
  else name = isKnownPage(page) ? PAGE_TITLE[page]! : "없는 주소";
  return `${name} · ${SITE_NAME}`;
}

/** 주소가 바뀔 때마다 문서 제목(브라우저 탭·방문 기록)을 그 화면 이름으로 바꾼다. */
function useDocumentTitle(route: string[], loggedIn: boolean, siteAdmin: boolean): void {
  const title = pageTitle(route, loggedIn, siteAdmin);
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** 모르는 주소. 조용히 오늘 화면으로 보내지 않고 알린다(주소를 잘못 옮겨 적은 경우 등). */
function NotFound() {
  return (
    <div className="screen">
      <h1>없는 주소예요</h1>
      <p>주소가 바뀌었거나 잘못 적혔을 수 있어요.</p>
      <button type="button" className="primary" onClick={() => go("/")}>
        오늘 화면으로
      </button>
    </div>
  );
}

/**
 * 상단 바: 사이트 이름, 테마 고르기, 로그인 상태(운영 화면만). 주 메뉴는 이 바 아래 한 줄(넓은 화면) 또는 화면 아래(좁은 화면).
 * 사이트 이름은 중립색 글자다(CLAUDE.md 5절: 로고를 강조색으로 칠하지 않는다).
 * 조회 링크로 들어온 사람에게는 운영 화면으로 가는 로고 링크와 로그인 버튼을 주지 않는다.
 */
function TopBar(props: { homeLink?: boolean; actions?: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const mark = <span>{SITE_NAME}</span>;
  return (
    <>
    {/* 키보드로 들어오면 첫 칸. 상단 바·메뉴 6~7칸을 건너 본문(main)에 초점을 둔다. 주소가 해시 라우팅(#/…)이라
        href="#main" 링크는 화면을 바꿔 버리므로 버튼으로 main에 직접 초점을 준다. 화면이 바뀌어도 main은 그대로라 늘 동작한다. */}
    <button
      type="button"
      className="skip-link"
      onClick={() => document.querySelector<HTMLElement>("main")?.focus()}
    >
      본문으로 건너뛰기
    </button>
    <header className="topbar">
      <div className="topbar-inner">
        {props.homeLink ? (
          <a className="brand" href="#/" aria-label={`${SITE_NAME} 첫 화면`}>
            {mark}
          </a>
        ) : (
          <span className="brand">{mark}</span>
        )}
        <div className="topbar-actions">
          <select
            className="theme-select"
            aria-label="화면 테마"
            value={theme}
            onChange={(event) => {
              const next = event.target.value as Theme;
              setTheme(next);
              applyTheme(next, true);
            }}
          >
            {THEMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {props.actions}
        </div>
      </div>
    </header>
    </>
  );
}

/**
 * 라이엇 게임즈와 무관한 서비스임을 알리는 문구. 디자인 키트의 안내에 따라 모든 화면 아래에 둔다.
 * 챔피언 초상화(라이엇 자산)를 켜 두면 라이엇 "Legal Jibber Jabber" 정책이 요구하는 문구를 원문 그대로 더하고,
 * 끄면(src/web/portraits.ts CHAMPION_PORTRAITS) 그 문구를 빼고 "게임 이미지를 쓰지 않는다"는 예전 문구로 돌아간다.
 */
function LegalFooter(props: { privacyHref?: string }) {
  return (
    // 배치 때문에 <main> 안에 두므로, 보조 기기가 사이트 푸터로 알도록 역할을 직접 적는다.
    <footer className="legal" role="contentinfo">
      <p>
        {SITE_NAME} isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot
        Games or anyone officially involved in producing or managing Riot Games properties. Riot
        Games, and all associated properties are trademarks or registered trademarks of Riot Games,
        Inc.
      </p>
      {CHAMPION_PORTRAITS ? (
        <>
          <p>
            {SITE_NAME} was created under Riot Games' "Legal Jibber Jabber" policy using assets owned by
            Riot Games. Riot Games does not endorse or sponsor this project.
          </p>
          <p>
            이 사이트는 라이엇 게임즈의 공식 서비스가 아니며, 내전 모임의 경기 기록과 통계를 위해
            만들었습니다. 라이엇 게임즈의 로고·상표는 쓰지 않습니다. 챔피언 초상화는 라이엇 게임즈의
            자산이며 위 정책에 따라 라이엇이 공개한 자료(Data Dragon)에서 불러옵니다. 라인 아이콘은 직접
            그린 도형입니다.
          </p>
        </>
      ) : (
        <p>
          이 사이트는 라이엇 게임즈의 공식 서비스가 아니며, 내전 모임의 경기 기록과 통계를 위해
          만들었습니다. 라이엇 게임즈의 로고·상표·게임 이미지를 쓰지 않고, 라인 아이콘은 직접 그린
          도형입니다.
        </p>
      )}
      <p>
        무료 요금제로 운영하는 사이트라 하루 이용량이 한도를 넘으면 그날 한국 시각 오전 9시까지 멈출 수
        있습니다. 그때는 잠시 뒤 다시 열어 주세요.
      </p>
      <p className="legal-links">
        <a href={props.privacyHref ?? "#/privacy"}>개인정보 처리방침</a>
      </p>
    </footer>
  );
}

/** 기록이 필요한 화면인데 서버에서 받지 못했을 때(네트워크 오류·서버 오류). "기록이 없어요"와 구분한다. */
function LoadFailed() {
  const app = useAppValue();
  const [busy, setBusy] = useState(false);
  return (
    <div className="screen">
      <h1>불러오지 못했어요</h1>
      <p className="note error" role="alert">
        {app.loadError?.kind === "offline"
          ? "인터넷에 연결돼 있지 않아요. 연결되면 다시 시도해 주세요."
          : app.loadError?.status === 429 || app.loadError?.status === 503
            ? app.loadError.message
            : "서버에서 기록을 받지 못했어요. 잠시 뒤 다시 시도해 주세요."}{" "}
        작성 중인 편성은 이 기기에 그대로 있어요.
      </p>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void app.refresh().finally(() => setBusy(false));
        }}
      >
        {busy ? "불러오는 중…" : "다시 시도"}
      </button>
    </div>
  );
}

/** 기록(스냅숏)이 있어야 그릴 수 있는 화면. */
const NEEDS_SNAPSHOT = new Set(["records", "m", "graphs", "ranking", "champions", "p", "compare", "search", "group", "merge", "backfill", "priority", "season", "dates"]);

function OperatorScreen(props: { route: string[] }) {
  const app = useAppValue();
  const [page, id] = props.route;
  if (page === "privacy") return <Privacy back={() => go("/")} backLabel="← 오늘" />;
  if (page === "login-failed") return <LoginFailed reason={id ?? ""} />;
  // 로그인 만료(401)는 각 화면이 로그인 안내를 보여준다. 그 밖의 불러오기 실패는 "기록 없음"과 구분해 알린다.
  if (
    page !== undefined &&
    NEEDS_SNAPSHOT.has(page) &&
    !app.snapshot &&
    app.loadError &&
    app.loadError.status !== 401
  ) {
    return <LoadFailed />;
  }
  // 로그인해야 쓰는 화면: 로그인 안내를 보여준다. 로그인하면 주소가 그대로라 그 화면이 열린다.
  // 계정 정보를 받지 못한 경우(네트워크 오류)는 로그인 문제가 아니므로 불러오기 실패로 알린다.
  if (page !== undefined && page in LOGIN_ONLY && !app.me?.accountId) {
    if (!app.me && app.loadError) return <LoadFailed />;
    return <LoginRequired title={LOGIN_ONLY[page]!} />;
  }
  // 사이트 운영자 현황. 사이트 운영자가 아니면 없는 화면처럼 첫 화면을 보여 준다(메뉴에도 없다).
  if (page === "admin" && app.me?.siteAdmin) return <SiteAdmin />;
  if (page === "pick") return <Pick />;
  if (page === "prep") return <Prep />;
  if (page === "priority") return <PriorityScreen tab={id === "avoid" ? "avoid" : "priority"} />;
  if (page === "match") return <Match />;
  if (page === "group") return <Group />;
  if (page === "import") return <Import />;
  if (page === "sheet-import") return <SheetImport />;
  if (page === "legacy-import") return <LegacyImport />;
  if (page === "backfill") return <Backfill />;
  if (page === "merge") return <Merge />;
  if (page === "dates") return <DateCheck />;
  if (page === "delete") return <DangerZone />;
  if (page === "search") {
    if (!app.snapshot) {
      return (
        <div className="screen">
          <h1>전적 검색</h1>
          <p>아직 기록이 없어요. 경기를 저장하면 이름으로 전적을 찾을 수 있어요.</p>
        </div>
      );
    }
    return (
      <Search
        snapshot={app.snapshot}
        openPerson={(personId) => go(`/p/${personId}`)}
        openCompare={(a, b) => go(`/compare/${a}/${b}`)}
        openMatch={(matchId) => go(`/m/${matchId}`)}
      />
    );
  }
  if (page === "transfer" && id) return <Transfer token={id} />;
  if (page === "co-invite" && id) return <CoInvite token={id} />;
  // 참가자 본인 연결(migrations/0019): 연결 링크와 참가 중인 모임의 읽기 전용 화면.
  if (page === "claim" && id) return <Claim token={id} />;
  if (page === "mine" && id) return <Member gid={id} rest={props.route.slice(2)} />;
  if (page === "records") return <OperatorRecords />;
  if (page === "m" && id) {
    if (!app.snapshot) return <p className="screen">기록이 없어요.</p>;
    return (
      <MatchDetail
        snapshot={app.snapshot}
        matchId={id}
        app={app}
        back={() => go("/records")}
        openMatch={(matchId) => go(`/m/${matchId}`)}
      />
    );
  }
  if (page === "season") {
    if (!app.snapshot) return <p className="screen">기록이 없어요.</p>;
    return (
      <SeasonSummaryScreen
        snapshot={app.snapshot}
        scope={seasonScopeFromRoute(props.route.slice(1))}
        back={() => go("/records")}
        choose={(scope) => go(`/season/${seasonRoutePart(scope)}`)}
      />
    );
  }
  if (page === "graphs") {
    if (!app.snapshot) {
      return (
        <div className="screen">
          <h1>그래프 분석</h1>
          <p>아직 기록이 없어요. 경기를 저장하면 개인별·라인별·진영별 승률을 여기서 봅니다.</p>
          <button type="button" className="primary" onClick={() => go("/pick")}>
            이름 넣고 팀 짜기
          </button>
        </div>
      );
    }
    return (
      <Graphs
        snapshot={app.snapshot}
        openPerson={(personId) => go(`/p/${personId}`)}
        back={() => go("/records")}
        player={id ?? ""}
        choosePlayer={(personId) => go(personId ? `/graphs/${personId}` : "/graphs")}
        emptyAction={
          <button type="button" className="primary" onClick={() => go("/pick")}>
            이름 넣고 팀 짜기
          </button>
        }
      />
    );
  }
  if (page === "ranking") {
    if (!app.snapshot) {
      return (
        <div className="screen">
          <h1>MMR 랭킹</h1>
          <p>확정 경기가 쌓이면 보여요.</p>
        </div>
      );
    }
    return (
      <Ranking
        snapshot={app.snapshot}
        openPerson={(personId) => go(`/p/${personId}`)}
        openChampions={() => go("/champions")}
        emptyAction={
          <button type="button" className="primary" onClick={() => go("/pick")}>
            이름 넣고 팀 짜기
          </button>
        }
      />
    );
  }
  // 기록이 없으면(모임이 없는 계정) 아래의 알려진 화면 처리로 오늘 화면을 보여 준다.
  if (page === "champions" && app.snapshot) {
    return (
      <ChampionTier
        snapshot={app.snapshot}
        openMatch={(matchId) => go(`/m/${matchId}`)}
        openPerson={(personId) => go(`/p/${personId}`)}
        operator
      />
    );
  }
  if (page === "p" && id) {
    if (!app.snapshot) return <p className="screen">기록이 없어요.</p>;
    return (
      <Person
        snapshot={app.snapshot}
        participantId={id}
        back={() => go("/records")}
        openMatch={(matchId) => go(`/m/${matchId}`)}
        openPerson={(personId) => go(`/p/${personId}`)}
        openCompare={(personId, other) => go(`/compare/${personId}/${other ?? "-"}`)}
        openGraphs={(personId) => go(`/graphs/${personId}`)}
      />
    );
  }
  if (page === "compare") {
    if (!app.snapshot) return <p className="screen">기록이 없어요.</p>;
    return (
      <Compare
        snapshot={app.snapshot}
        a={id ?? null}
        b={props.route[2] ?? null}
        choose={(a, b) => go(`/compare/${a ?? "-"}/${b ?? "-"}`)}
        openMatch={(matchId) => go(`/m/${matchId}`)}
        openPerson={(personId) => go(`/p/${personId}`)}
        back={() => go("/records")}
      />
    );
  }
  // 알려진 화면인데 필요한 조각(ID 등)이 없거나, admin인데 사이트 운영자가 아니면(존재를 숨김) 오늘 화면.
  if (isKnownPage(page)) return <Today />;
  return <NotFound />;
}

/**
 * 주 메뉴: 오늘 · 검색 · 기록 · 랭킹 · 챔피언 · 분석 · 모임. 모임 탭은 로그인한 운영자에게만 보인다.
 * 좁은 화면(하단 탭)은 6칸이 한계라 "챔피언"을 숨기고(.nav-wide-only) 랭킹 화면 머리의 링크로 간다.
 */
function Tabs(props: { current: string }) {
  const app = useAppValue();
  const tab =
    props.current === "records" ||
    props.current === "m" ||
    props.current === "season" ||
    props.current === "p" ||
    props.current === "compare"
      ? "records"
      : props.current === "graphs" || props.current === "ranking" || props.current === "champions"
        ? props.current
        : props.current === "group" ||
            props.current === "import" ||
            props.current === "sheet-import" ||
            props.current === "legacy-import" ||
            props.current === "backfill" ||
            props.current === "merge" ||
            props.current === "dates" ||
            props.current === "priority" ||
            props.current === "delete"
          ? "group"
          : props.current === "search"
            ? "search"
            : "today";
  const item = (name: typeof tab, path: string, label: string, icon: LineIconName, wideOnly = false) => (
    <button
      type="button"
      className={wideOnly ? "nav-wide-only" : undefined}
      aria-current={tab === name ? "page" : undefined}
      onClick={() => go(path)}
    >
      <LineIcon name={icon} />
      {label}
    </button>
  );
  return (
    <nav className="tabs" aria-label="주 메뉴">
      {/* 넓은 화면에서 줄 테두리는 창 폭 전체, 칸은 본문 폭(--content-max) 안에 맞추려고 안쪽 묶음을 둔다. */}
      <div className="tabs-inner">
        {item("today", "/", "오늘", "today")}
        {item("search", "/search", "검색", "search")}
        {item("records", "/records", "기록", "records")}
        {item("ranking", "/ranking", "랭킹", "ranking")}
        {item("champions", "/champions", "챔피언", "champions", true)}
        {item("graphs", "/graphs", "분석", "graphs")}
        {app.me?.accountId && item("group", "/group", "모임", "group")}
      </div>
    </nav>
  );
}
