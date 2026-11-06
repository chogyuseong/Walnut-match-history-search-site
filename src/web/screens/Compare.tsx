import { useMemo, useState } from "react";
import { headToHead, mainLine, resultsOf, streakOf, streakText } from "../../shared/insights";
import {
  matchesInScope,
  personDetail,
  personRecords,
  scopeLabel as scopeLabelOf,
  SMALL_SAMPLE,
  type Scope,
  type Tally,
} from "../../shared/stats";
import { resolveMerged } from "../../shared/merge";
import { POSITIONS, type Snapshot } from "../../shared/types";
import { nameMap, POSITION_LABEL, rateTier, standingsOf } from "../format";
import { MatchCard } from "../matchCard";
import { useSeriesBadges } from "../seriesPanel";
import { BackLink, PosLabel, ScopePicker, StandingNote } from "../ui";

function rateText(t: Tally): string {
  return t.games === 0 ? "기록 없음" : `${Math.round((t.wins / t.games) * 100)}%`;
}

function wl(t: Tally): string {
  return t.games === 0 ? "" : `${t.wins}승 ${t.games - t.wins}패`;
}

/** 경기 카드를 처음에 보여주는 수와 "더 보기"로 더 여는 수(개인 통계와 같다). */
const FIRST_PAGE = 10;
const PAGE = 20;

/**
 * 두 사람 비교(#/compare/A/B). 운영자와 조회 링크가 같은 화면을 쓴다.
 * 두 사람의 성적을 나란히, 같은 팀일 때와 상대일 때의 전적, 맞대결 경기 목록을 보여준다.
 * 범위 필터를 따르고, 배치·칭호는 누적 기준이다.
 */
export function Compare(props: {
  snapshot: Snapshot;
  a: string | null;
  b: string | null;
  /** 사람을 바꾼다. null이면 아직 고르지 않음. */
  choose: (a: string | null, b: string | null) => void;
  openMatch: (id: string) => void;
  openPerson: (id: string) => void;
  back: () => void;
}) {
  const { snapshot } = props;
  // 합쳐진 사람의 주소로 들어오면 남은 사람으로 비교한다(기록은 모두 남은 사람에게 있다).
  const a = props.a && props.a !== "-" ? resolveMerged(snapshot.participants, props.a) : null;
  const b = props.b && props.b !== "-" ? resolveMerged(snapshot.participants, props.b) : null;
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [list, setList] = useState<"against" | "together">("against");
  const [shown, setShown] = useState(FIRST_PAGE);
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const seriesBadge = useSeriesBadges(snapshot);
  const scoped = useMemo(() => matchesInScope(snapshot, scope), [snapshot, scope]);
  const standings = useMemo(() => standingsOf(snapshot), [snapshot]);
  // 고를 수 있는 사람: 확정 경기가 한 번이라도 있는 사람(누적), 이름순.
  const people = useMemo(
    () =>
      [...personRecords(snapshot.matches).keys()].sort((x, y) =>
        nameOf(x).localeCompare(nameOf(y), "ko"),
      ),
    [snapshot, nameOf],
  );
  const known = (id: string | null) =>
    id !== null && snapshot.participants.some((p) => p.id === id && !p.mergedInto);
  const ready = known(a) && known(b) && a !== b;

  const da = useMemo(() => (ready ? personDetail(scoped, a!, nameOf) : null), [ready, scoped, a, nameOf]);
  const db = useMemo(() => (ready ? personDetail(scoped, b!, nameOf) : null), [ready, scoped, b, nameOf]);
  const sa = useMemo(() => (ready ? streakOf(resultsOf(scoped, a!)) : null), [ready, scoped, a]);
  const sb = useMemo(() => (ready ? streakOf(resultsOf(scoped, b!)) : null), [ready, scoped, b]);
  const h2h = useMemo(() => (ready ? headToHead(scoped, a!, b!) : null), [ready, scoped, a, b]);

  const picker = (
    <div className="filter-row compare-pick">
      {(["a", "b"] as const).map((slot) => {
        const value = slot === "a" ? a : b;
        const other = slot === "a" ? b : a;
        return (
          <label key={slot}>
            {slot === "a" ? "첫 번째 사람" : "두 번째 사람"}
            <select
              aria-label={slot === "a" ? "첫 번째 사람" : "두 번째 사람"}
              value={known(value) ? value! : ""}
              onChange={(e) => {
                const next = e.target.value || null;
                setShown(FIRST_PAGE);
                if (slot === "a") props.choose(next, b);
                else props.choose(a, next);
              }}
            >
              <option value="">고르기</option>
              {people
                .filter((id) => id !== other)
                .map((id) => (
                  <option key={id} value={id}>
                    {nameOf(id)}
                  </option>
                ))}
            </select>
          </label>
        );
      })}
    </div>
  );

  if (!ready || !da || !db || !sa || !sb || !h2h) {
    return (
      <div className="screen">
        <header className="screen-head">
          <BackLink label="← 기록" fallback={props.back} />
          <h1>두 사람 비교</h1>
        </header>
        {picker}
        <p className="hint">
          {people.length < 2
            ? "확정된 경기가 있는 사람이 두 명 이상이어야 비교할 수 있어요."
            : "비교할 두 사람을 골라 주세요. 승률·라인별 승률·같은 팀일 때·상대일 때 전적을 나란히 보여줍니다."}
        </p>
      </div>
    );
  }

  const scopeLabel = scopeLabelOf(snapshot, scope);
  const nameA = nameOf(a!);
  const nameB = nameOf(b!);
  const mainA = mainLine(da.byPosition);
  const mainB = mainLine(db.byPosition);
  const matches = list === "against" ? h2h.againstMatches : h2h.togetherMatches;

  const cell = (t: Tally) => (
    <>
      <span className={rateTier(t.wins, t.games)}>{rateText(t)}</span>
      {t.games > 0 && (
        <span className="cmp-sub">
          {wl(t)} · {t.games}경기
          {t.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
        </span>
      )}
    </>
  );

  return (
    <div className="screen cols">
      <header className="screen-head">
        <BackLink label="← 기록" fallback={props.back} />
        <h1>
          {nameA} <span className="vs">vs</span> {nameB}
        </h1>
      </header>
      {picker}
      <ScopePicker
        snapshot={snapshot}
        scope={scope}
        onChange={(next) => {
          setScope(next);
          setShown(FIRST_PAGE);
        }}
      />

      <section className="card" aria-label="나란히 보기">
        <h2>나란히 보기 ({scopeLabel})</h2>
        <table className="cmp-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">항목</span>
              </th>
              <th scope="col">
                <button type="button" className="link cmp-name" onClick={() => props.openPerson(a!)}>
                  {nameA}
                </button>
              </th>
              <th scope="col">
                <button type="button" className="link cmp-name" onClick={() => props.openPerson(b!)}>
                  {nameB}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">승률</th>
              <td>{cell(da.summary)}</td>
              <td>{cell(db.summary)}</td>
            </tr>
            <tr>
              <th scope="row">배치·칭호</th>
              <td className="cmp-small">
                <StandingNote standing={standings.get(a!)} />
              </td>
              <td className="cmp-small">
                <StandingNote standing={standings.get(b!)} />
              </td>
            </tr>
            <tr>
              <th scope="row">지금</th>
              <td>{streakText(sa.currentStreak) || "기록 없음"}</td>
              <td>{streakText(sb.currentStreak) || "기록 없음"}</td>
            </tr>
            <tr>
              <th scope="row">최다 연승</th>
              <td>{sa.longestWinStreak}연승</td>
              <td>{sb.longestWinStreak}연승</td>
            </tr>
            <tr>
              <th scope="row">주 라인</th>
              <td>{mainA ? POSITION_LABEL[mainA.position] : "기록 없음"}</td>
              <td>{mainB ? POSITION_LABEL[mainB.position] : "기록 없음"}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="card" aria-label="라인별 승률 비교">
        <h2>라인별 승률 ({scopeLabel})</h2>
        <table className="cmp-table">
          <thead>
            <tr>
              <th scope="col">라인</th>
              <th scope="col">{nameA}</th>
              <th scope="col">{nameB}</th>
            </tr>
          </thead>
          <tbody>
            {POSITIONS.map((p) => (
              <tr key={p}>
                <th scope="row">
                  <PosLabel position={p} />
                </th>
                <td>{cell(da.byPosition[p] ?? { games: 0, wins: 0 })}</td>
                <td>{cell(db.byPosition[p] ?? { games: 0, wins: 0 })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(da.positionUnknown > 0 || db.positionUnknown > 0) && (
          <p className="hint">
            포지션 기록이 없는 경기는 뺐습니다({nameA} {da.positionUnknown}경기, {nameB}{" "}
            {db.positionUnknown}경기).
          </p>
        )}
      </section>

      <section className="card" aria-label="같은 팀일 때">
        <h2>같은 팀일 때 ({scopeLabel})</h2>
        {h2h.together.games === 0 ? (
          <p className="hint">같은 팀으로 뛴 경기가 없어요.</p>
        ) : (
          <p className="cmp-big">
            <span className={rateTier(h2h.together.wins, h2h.together.games)}>
              {rateText(h2h.together)}
            </span>{" "}
            · {wl(h2h.together)} ({h2h.together.games}경기)
            {h2h.together.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
          </p>
        )}
      </section>

      <section className="card" aria-label="상대일 때">
        <h2>상대일 때 ({scopeLabel})</h2>
        {h2h.against.games === 0 ? (
          <p className="hint">상대 팀으로 만난 경기가 없어요.</p>
        ) : (
          <>
            <p className="cmp-big">
              {nameA} <strong>{h2h.against.aWins}승</strong> : <strong>{h2h.against.bWins}승</strong> {nameB}
              {h2h.against.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
            </p>
            <div
              className="cmp-bar"
              role="img"
              aria-label={`${h2h.against.games}경기 중 ${nameA} ${h2h.against.aWins}승, ${nameB} ${h2h.against.bWins}승`}
            >
              <span style={{ width: `${(h2h.against.aWins / h2h.against.games) * 100}%` }} />
            </div>
            <p className="hint">{h2h.against.games}경기 기준. 경기 수가 적으면 우연일 수 있습니다.</p>
          </>
        )}
      </section>

      <section className="full" aria-label="맞대결 경기">
        <h2>함께 뛴 경기</h2>
        <div className="segmented" role="group" aria-label="경기 목록 고르기">
          <button
            type="button"
            aria-pressed={list === "against"}
            onClick={() => {
              setList("against");
              setShown(FIRST_PAGE);
            }}
          >
            맞대결 {h2h.against.games}
          </button>
          <button
            type="button"
            aria-pressed={list === "together"}
            onClick={() => {
              setList("together");
              setShown(FIRST_PAGE);
            }}
          >
            같은 팀 {h2h.together.games}
          </button>
        </div>
        {matches.length === 0 ? (
          <p className="hint">이 범위에는 해당하는 경기가 없어요.</p>
        ) : (
          <ul className="list match-cards">
            {matches.slice(0, shown).map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                nameOf={nameOf}
                timeZone={snapshot.group.timezone}
                showDate
                focusId={a}
                highlightIds={[a!, b!]}
                onOpen={() => props.openMatch(m.id)}
                seriesBadge={seriesBadge(m.id)}
                onPerson={props.openPerson}
              />
            ))}
          </ul>
        )}
        {matches.length > shown && (
          <button type="button" className="link" onClick={() => setShown(shown + PAGE)}>
            나머지 {matches.length - shown}경기 중 {Math.min(PAGE, matches.length - shown)}경기 더 보기
          </button>
        )}
        <p className="hint">카드 색과 승·패 표시는 {nameA} 기준입니다.</p>
      </section>
    </div>
  );
}
