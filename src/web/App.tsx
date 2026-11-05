import { useState } from "react";
import type { MatchView } from "../shared/types";
import { nameMap } from "./format";
import { Graphs } from "./screens/Graphs";
import { Group } from "./screens/Group";
import { Import } from "./screens/Import";
import { Match } from "./screens/Match";
import { Person } from "./screens/Person";
import { Pick } from "./screens/Pick";
import { Prep } from "./screens/Prep";
import { MatchDetail, Records } from "./screens/Records";
import { ResultSheet } from "./screens/ResultSheet";
import { Today } from "./screens/Today";
import { Transfer } from "./screens/Transfer";
import { Viewer } from "./screens/Viewer";
import { applyTheme, readTheme, THEMES, type Theme } from "./theme";
import { AppContext, go, useApp, useAppValue, useRoute } from "./useApp";

export function App() {
  const route = useRoute();
  const isViewer = route[0] === "v" && typeof route[1] === "string";
  const app = useApp(!isViewer);

  if (isViewer) {
    return (
      <>
        <TopBar />
        <main>
          <Viewer token={route[1]!} rest={route.slice(2)} />
          <LegalFooter />
        </main>
      </>
    );
  }

  return (
    <AppContext.Provider value={app}>
      <TopBar homeLink />
      <main>
        {!app.ready ? <p className="screen">불러오는 중…</p> : <OperatorScreen route={route} />}
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
 * 상단 바: 로고와 테마 고르기. 넓은 화면에서는 주 메뉴가 이 바의 가운데에 겹쳐 놓인다(CSS).
 * 조회 링크로 들어온 사람에게는 운영 화면으로 가는 로고 링크를 주지 않는다.
 */
function TopBar(props: { homeLink?: boolean }) {
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
    <header className="topbar">
      <div className="topbar-inner">
        {props.homeLink ? (
          <a className="brand" href="#/" aria-label={`${SITE_NAME} 첫 화면`}>
            {mark}
          </a>
        ) : (
          <span className="brand">{mark}</span>
        )}
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
      </div>
    </header>
  );
}

/** 라이엇 게임즈와 무관한 서비스임을 알리는 문구. 디자인 키트의 안내에 따라 모든 화면 아래에 둔다. */
function LegalFooter() {
  return (
    <footer className="legal">
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
    </footer>
  );
}

function OperatorScreen(props: { route: string[] }) {
  const app = useAppValue();
  const [page, id] = props.route;
  if (page === "pick") return <Pick />;
  if (page === "prep") return <Prep />;
  if (page === "match") return <Match />;
  if (page === "group") return <Group />;
  if (page === "import") return <Import />;
  if (page === "transfer" && id) return <Transfer token={id} />;
  if (page === "records") return <OperatorRecords />;
  if (page === "m" && id) {
    if (!app.snapshot) return <p className="screen">기록이 없어요.</p>;
    return (
      <MatchDetail snapshot={app.snapshot} matchId={id} app={app} back={() => go("/records")} />
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
        onResult={setResultFor}
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

/** 하단 탭: 오늘 · 기록 · 모임. 모임 탭은 로그인한 운영자에게만 보인다. */
function Tabs(props: { current: string }) {
  const app = useAppValue();
  const tab =
    props.current === "records" || props.current === "m" || props.current === "p"
      ? "records"
      : props.current === "graphs"
        ? "graphs"
        : props.current === "group" || props.current === "import"
          ? "group"
          : "today";
  return (
    <nav className="tabs" aria-label="주 메뉴">
      <button type="button" aria-current={tab === "today" ? "page" : undefined} onClick={() => go("/")}>
        오늘
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
