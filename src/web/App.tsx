import { useState, type ReactNode } from "react";
import { AccountControl, LOGIN_ONLY, LoginRequired } from "./account";
import type { MatchView } from "../shared/types";
import { nameMap } from "./format";
import { Backfill } from "./screens/Backfill";
import { Compare } from "./screens/Compare";
import { DangerZone } from "./screens/DangerZone";
import { Graphs } from "./screens/Graphs";
import { Group } from "./screens/Group";
import { Import } from "./screens/Import";
import { SheetImport } from "./screens/SheetImport";
import { LegacyImport } from "./screens/LegacyImport";
import { Match } from "./screens/Match";
import { Merge } from "./screens/Merge";
import { Person } from "./screens/Person";
import { Pick } from "./screens/Pick";
import { Prep } from "./screens/Prep";
import { PriorityScreen } from "./screens/Priority";
import { MatchDetail, Records } from "./screens/Records";
import { ResultSheet } from "./screens/ResultSheet";
import { SeasonSummaryScreen, seasonRoutePart, seasonScopeFromRoute } from "./screens/SeasonSummary";
import { Search } from "./screens/Search";
import { Today } from "./screens/Today";
import { Transfer } from "./screens/Transfer";
import { CoInvite } from "./screens/CoOperators";
import { Viewer } from "./screens/Viewer";
import { Join } from "./screens/Join";
import { LoginFailed } from "./screens/Login";
import { Privacy } from "./screens/Privacy";
import { applyTheme, readTheme, THEMES, type Theme } from "./theme";
import { useKeyboardFlag } from "./ui";
import { AppContext, go, useApp, useAppValue, useRoute } from "./useApp";

export function App() {
  const route = useRoute();
  const isViewer = route[0] === "v" && typeof route[1] === "string";
  // 참가 신청(#/join/토큰)도 로그인 없이 여는 화면이라 운영자 상태를 읽지 않는다.
  const isJoin = route[0] === "join" && typeof route[1] === "string";
  const app = useApp(!isViewer && !isJoin);
  useKeyboardFlag();

  if (isJoin) {
    return (
      <>
        <TopBar />
        <main>
          <Join token={route[1]!} rest={route.slice(2)} />
          <LegalFooter privacyHref={`#/join/${route[1]}/privacy`} />
        </main>
      </>
    );
  }

  if (isViewer) {
    return (
      <>
        <TopBar />
        <main>
          <Viewer token={route[1]!} rest={route.slice(2)} />
          {/* 조회 링크로 들어온 사람은 처리방침을 보고도 조회 화면으로 돌아올 수 있게 같은 링크 아래에서 연다. */}
          <LegalFooter privacyHref={`#/v/${route[1]}/privacy`} />
        </main>
      </>
    );
  }

  return (
    <AppContext.Provider value={app}>
      <TopBar homeLink actions={<AccountControl />} />
      <main>
        {!app.ready || app.switching ? (
          <p className="screen">불러오는 중…</p>
        ) : (
          // 모임을 바꾸면 화면을 새로 그린다(앞 모임에서 입력하던 상태가 남지 않게).
          <OperatorScreen key={app.switchSeq} route={route} />
        )}
        <LegalFooter />
      </main>
      <Tabs current={route[0] ?? ""} />
      {app.notice && (
        <p className="toast" role="status">
          {app.notice}
        </p>
      )}
    </AppContext.Provider>
  );
}

/** 사이트 이름. 상단 바와 푸터가 함께 쓴다. */
const SITE_NAME = "내전 운영";

/**
 * 상단 바: 로고, 테마 고르기, 로그인 상태(운영 화면만). 넓은 화면에서는 주 메뉴가 이 바에 겹쳐 놓인다(CSS).
 * 조회 링크로 들어온 사람에게는 운영 화면으로 가는 로고 링크와 로그인 버튼을 주지 않는다.
 */
function TopBar(props: { homeLink?: boolean; actions?: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const mark = (
    <>
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" focusable="false">
          <polygon
            points="12 2 20 7 20 17 12 22 4 17 4 7"
            stroke="currentColor"
            strokeWidth="2"
            fill="rgba(255,255,255,0.15)"
          />
          <path d="M8 15L12 7L16 15H8Z" fill="currentColor" />
        </svg>
      </span>
      <span>
        내전 <em>운영</em>
      </span>
    </>
  );
  return (
    <header className={props.actions ? "topbar topbar-operator" : "topbar"}>
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
                테마: {t.label}
              </option>
            ))}
          </select>
          {props.actions}
        </div>
      </div>
    </header>
  );
}

/** 라이엇 게임즈와 무관한 서비스임을 알리는 문구. 디자인 키트의 안내에 따라 모든 화면 아래에 둔다. */
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
      <p>
        이 사이트는 라이엇 게임즈의 공식 서비스가 아니며, 내전 모임의 경기 기록과 통계를 위해
        만들었습니다. 라이엇 게임즈의 로고·상표·게임 이미지를 쓰지 않고, 라인 아이콘은 직접 그린
        도형입니다.
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
      <p className="note warn" role="alert">
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
const NEEDS_SNAPSHOT = new Set(["records", "m", "graphs", "p", "compare", "search", "group", "merge", "backfill", "priority", "season"]);

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
      />
    );
  }
  if (page === "transfer" && id) return <Transfer token={id} />;
  if (page === "co-invite" && id) return <CoInvite token={id} />;
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
        openCompare={(personId) => go(`/compare/${personId}/-`)}
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
  return <Today />;
}

function OperatorRecords() {
  const app = useAppValue();
  const [resultFor, setResultFor] = useState<MatchView | null>(null);
  if (!app.snapshot) {
    return (
      <div className="screen">
        <h1>기록</h1>
        <p>아직 기록이 없어요.</p>
        <button type="button" className="primary" onClick={() => go("/pick")}>
          이름 넣고 팀 짜기
        </button>
      </div>
    );
  }
  return (
    <>
      <Records
        snapshot={app.snapshot}
        openMatch={(matchId) => go(`/m/${matchId}`)}
        openPerson={(personId) => go(`/p/${personId}`)}
        openGraphs={() => go("/graphs")}
        openBackfill={app.me?.accountId ? () => go("/backfill") : undefined}
        onResult={setResultFor}
        openSeason={(scope) => go(`/season/${seasonRoutePart(scope)}`)}
        app={app.me?.accountId ? app : null}
      />
      {resultFor && (
        <ResultSheet
          match={resultFor}
          mode="result"
          nameOf={nameMap(app.snapshot)}
          onClose={() => setResultFor(null)}
        />
      )}
    </>
  );
}

/** 주 메뉴: 오늘 · 검색 · 기록 · 분석 · 모임. 모임 탭은 로그인한 운영자에게만 보인다. */
function Tabs(props: { current: string }) {
  const app = useAppValue();
  const tab =
    props.current === "records" ||
    props.current === "m" ||
    props.current === "season" ||
    props.current === "p" ||
    props.current === "compare"
      ? "records"
      : props.current === "graphs"
        ? "graphs"
        : props.current === "group" ||
            props.current === "import" ||
            props.current === "sheet-import" ||
            props.current === "legacy-import" ||
            props.current === "backfill" ||
            props.current === "merge" ||
            props.current === "priority" ||
            props.current === "delete"
          ? "group"
          : props.current === "search"
            ? "search"
            : "today";
  return (
    <nav className="tabs" aria-label="주 메뉴">
      <button type="button" aria-current={tab === "today" ? "page" : undefined} onClick={() => go("/")}>
        오늘
      </button>
      <button
        type="button"
        aria-current={tab === "search" ? "page" : undefined}
        onClick={() => go("/search")}
      >
        검색
      </button>
      <button
        type="button"
        aria-current={tab === "records" ? "page" : undefined}
        onClick={() => go("/records")}
      >
        기록
      </button>
      <button
        type="button"
        aria-current={tab === "graphs" ? "page" : undefined}
        onClick={() => go("/graphs")}
      >
        분석
      </button>
      {app.me?.accountId && (
        <button
          type="button"
          aria-current={tab === "group" ? "page" : undefined}
          onClick={() => go("/group")}
        >
          모임
        </button>
      )}
    </nav>
  );
}
