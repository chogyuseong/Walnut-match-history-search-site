import { useState } from "react";
import {
  matchesInScope,
  personDetail,
  placements,
  PLACEMENT_GAMES,
  SMALL_SAMPLE,
  type PairTally,
  type Scope,
  type Tally,
} from "../../shared/stats";
import { POSITIONS, type Snapshot } from "../../shared/types";
import { formatDate, nameMap, POSITION_LABEL, resultLine } from "../format";

function rate(tally: Tally): string {
  return tally.games === 0 ? "기록 없음" : `${Math.round((tally.wins / tally.games) * 100)}%`;
}

function line(tally: Tally): string {
  if (tally.games === 0) return "기록 없음";
  return `${rate(tally)} · ${tally.wins}승 ${tally.games - tally.wins}패 (${tally.games}경기)`;
}

/**
 * 개인 통계. 순서: 요약 → 최근 → 라인별 → 진영별 → 시너지 → 상대 전적 → 참여 경기(맨 아래).
 * 운영자와 조회자가 같은 화면을 본다. 실력 그룹은 보여주지 않는다.
 */
export function Person(props: {
  snapshot: Snapshot;
  participantId: string;
  back: () => void;
  openMatch: (id: string) => void;
  openPerson: (id: string) => void;
}) {
  const { snapshot, participantId } = props;
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [pairOrder, setPairOrder] = useState<"games" | "rate">("games");
  const nameOf = nameMap(snapshot);
  const person = snapshot.participants.find((p) => p.id === participantId);

  if (!person) {
    return (
      <div className="screen">
        <button type="button" className="link" onClick={props.back}>
          ← 기록
        </button>
        <p>참가자를 찾을 수 없어요.</p>
      </div>
    );
  }

  const season = scope.kind === "season" ? snapshot.seasons.find((s) => s.id === scope.seasonId) : null;
  const scopeLabel =
    scope.kind === "today" ? "오늘" : scope.kind === "all" ? "전체" : (season?.name ?? "시즌");
  const detail = personDetail(matchesInScope(snapshot, scope), participantId, nameOf);
  // 배치는 범위와 무관하게 전체 누적 기준이다.
  const placement = placements(snapshot.matches).get(participantId) ?? { games: 0, done: false };

  const orderPairs = (pairs: PairTally[]) =>
    pairOrder === "games"
      ? pairs
      : [...pairs].sort((a, b) => b.wins / b.games - a.wins / a.games || b.games - a.games);

  const pairList = (pairs: PairTally[], empty: string) =>
    pairs.length === 0 ? (
      <p className="hint">{empty}</p>
    ) : (
      <ul className="list">
        {orderPairs(pairs).map((pair) => (
          <li key={pair.participantId}>
            <button
              type="button"
              className="list-row"
              onClick={() => props.openPerson(pair.participantId)}
            >
              <span className="name">{nameOf(pair.participantId)}</span>
              <span className="stat">
                {line(pair)}
                {pair.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    );

  const streak =
    detail.currentStreak > 0
      ? `${detail.currentStreak}연승 중`
      : detail.currentStreak < 0
        ? `${-detail.currentStreak}연패 중`
        : "기록 없음";

  return (
    <div className="screen cols">
      <header className="screen-head">
        <button type="button" className="link" onClick={props.back}>
          ← 기록
        </button>
        <h1>{person.name}</h1>
        {person.status === "archived" && <span className="badge">보관</span>}
      </header>

      <div className="segmented" role="group" aria-label="범위">
        <button
          type="button"
          aria-pressed={scope.kind === "today"}
          onClick={() => setScope({ kind: "today" })}
        >
          오늘
        </button>
        {snapshot.seasons.length > 0 && (
          <select
            aria-label="시즌 선택"
            value={scope.kind === "season" ? scope.seasonId : ""}
            onChange={(e) => {
              if (e.target.value !== "") setScope({ kind: "season", seasonId: e.target.value });
            }}
          >
            <option value="">시즌</option>
            {snapshot.seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          aria-pressed={scope.kind === "all"}
          onClick={() => setScope({ kind: "all" })}
        >
          전체
        </button>
      </div>

      <section className="card" aria-label="요약">
        <h2>요약 ({scopeLabel})</h2>
        <p>
          <strong>{line(detail.summary)}</strong>
        </p>
        <p className="hint">
          {placement.done
            ? `배치 완료 · 누적 ${placement.games}경기 (누적 기준)`
            : `배치 진행 중 · ${placement.games}/${PLACEMENT_GAMES}경기 (누적 기준)`}
        </p>
      </section>

      <section aria-label="최근">
        <h2>최근 ({scopeLabel})</h2>
        <ul className="list">
          <li className="list-row static">
            <span>최근 {detail.recent10.games}경기</span>
            <span className="stat">{line(detail.recent10)}</span>
          </li>
          {detail.recent20.games > 10 && (
            <li className="list-row static">
              <span>최근 {detail.recent20.games}경기</span>
              <span className="stat">{line(detail.recent20)}</span>
            </li>
          )}
          <li className="list-row static">
            <span>연속</span>
            <span className="stat">
              {streak} · 최다 {detail.longestWinStreak}연승 / {detail.longestLoseStreak}연패
            </span>
          </li>
        </ul>
      </section>

      <section aria-label="라인별">
        <h2>라인별 ({scopeLabel})</h2>
        <ul className="list">
          {POSITIONS.map((position) => {
            const tally = detail.byPosition[position];
            return (
              <li key={position} className="list-row static">
                <span>{POSITION_LABEL[position]}</span>
                <span className="stat">
                  {tally ? line(tally) : "기록 없음"}
                  {tally && tally.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
                </span>
              </li>
            );
          })}
        </ul>
        {detail.positionUnknown > 0 && (
          <p className="hint">포지션 기록이 없는 {detail.positionUnknown}경기는 제외했습니다.</p>
        )}
      </section>

      <section aria-label="진영별">
        <h2>진영별 ({scopeLabel})</h2>
        <ul className="list">
          <li className="list-row static">
            <span>블루</span>
            <span className="stat">{line(detail.bySide.blue)}</span>
          </li>
          <li className="list-row static">
            <span>레드</span>
            <span className="stat">{line(detail.bySide.red)}</span>
          </li>
        </ul>
        {detail.sideUnknown > 0 && (
          <p className="hint">진영 미상 {detail.sideUnknown}경기는 제외했습니다.</p>
        )}
      </section>

      <div className="segmented" role="group" aria-label="시너지·상대 전적 순서">
        <button type="button" aria-pressed={pairOrder === "games"} onClick={() => setPairOrder("games")}>
          경기 수순
        </button>
        <button type="button" aria-pressed={pairOrder === "rate"} onClick={() => setPairOrder("rate")}>
          승률순
        </button>
      </div>

      <section aria-label="시너지">
        <h2>같은 팀일 때 ({scopeLabel})</h2>
        {pairList(detail.synergy, "같은 팀으로 한 경기가 없어요.")}
      </section>

      <section aria-label="상대 전적">
        <h2>상대 팀일 때 ({scopeLabel})</h2>
        {pairList(detail.versus, "상대 팀으로 만난 경기가 없어요.")}
        <p className="hint">승률은 {person.name} 기준입니다. 경기 수가 적으면 우연일 수 있습니다.</p>
      </section>

      <section className="full" aria-label="참여 경기">
        <h2>
          참여 경기 ({scopeLabel}) · {detail.matches.length}경기
        </h2>
        {detail.matches.length === 0 ? (
          <p className="hint">이 범위에는 확정된 경기가 없어요.</p>
        ) : (
          <ul className="list">
            {detail.matches.map((m) => {
              const me = m.roster.find((r) => r.participantId === participantId)!;
              return (
                <li key={m.id}>
                  <button type="button" className="list-row" onClick={() => props.openMatch(m.id)}>
                    <span>
                      {m.matchNo}경기 · {me.team === m.winnerTeam ? "승" : "패"} · 팀 {me.team}
                      {me.position ? ` ${POSITION_LABEL[me.position]}` : ""}
                      <br />
                      <span className="hint">{resultLine(m)}</span>
                    </span>
                    <span className="hint">{formatDate(m.playedAt, snapshot.group.timezone)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
