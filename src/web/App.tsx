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
import { AppContext, go, useApp, useAppValue, useRoute } from "./useApp";

export function App() {
  const route = useRoute();
  const isViewer = route[0] === "v" && typeof route[1] === "string";
  const app = useApp(!isViewer);

  if (isViewer) {
    return (
      <main>
        <Viewer token={route[1]!} rest={route.slice(2)} />
      </main>
    );
  }

  return (
    <AppContext.Provider value={app}>
      <main>
        {!app.ready ? <p className="screen">불러오는 중…</p> : <OperatorScreen route={route} />}
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
