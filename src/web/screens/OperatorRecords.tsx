import { useState } from "react";
import type { MatchView } from "../../shared/types";
import { nameMap } from "../format";
import { seasonRoutePart } from "../seasonRoute";
import { go, useAppValue } from "../useApp";
import { Records } from "./Records";
import { ResultSheet } from "./ResultSheet";

/** 운영자 기록 화면(#/records). 기록 목록과 결과 입력 창을 묶는다(App.tsx에서 옮김). */
export function OperatorRecords() {
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
