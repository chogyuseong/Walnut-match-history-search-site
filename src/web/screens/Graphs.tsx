import { useState } from "react";
import {
  matchesInScope,
  matchYears,
  personRecordsByLine,
  PLACEMENT_GAMES,
  scopeLabel as scopeLabelOf,
  playerLineMatrix,
  sideTotals,
  SMALL_SAMPLE,
  sortRanking,
  type Scope,
  type Tally,
} from "../../shared/stats";
import { POSITIONS, type Position, type Snapshot } from "../../shared/types";
import type { Standing } from "../../shared/titles";
import { nameMap, POSITION_LABEL, standingsOf } from "../format";
import { BackLink, scopeFromValue, scopeValue } from "../ui";

/** 막대 옆 짧은 표시: 배치 중이면 "배치 진행 중", 완료자는 칭호(누적 기준). */
function standingText(standing: Standing | undefined): string | undefined {
  if (!standing?.done) return "배치 진행 중";
  return standing.title ? `${standing.title}(누적)` : undefined;
}

function percent(wins: number, games: number): number {
  return games === 0 ? 0 : (wins / games) * 100;
}

function percentText(wins: number, games: number): string {
  return `${percent(wins, games).toFixed(1)}%`;
}

/**
 * 승률 막대 한 줄. 0~100% 한 축이고 50% 위치에 기준선을 둔다.
 * 값은 글자로 함께 쓰고(색에만 의존하지 않음), 글자는 본문 색을 쓴다.
 */
function RateBar(props: {
  label: string;
  note?: string;
  wins: number;
  games: number;
  tone?: "series" | "blue" | "red";
  onOpen?: () => void;
}) {
  const { wins, games } = props;
  const detail = `${props.label}: ${percentText(wins, games)} · ${wins}승 ${games - wins}패 (${games}경기)`;
  const body = (
    <>
      <span className="bar-head">
        <span className="name">
          {props.label}
          {props.note && <span className="bar-note"> · {props.note}</span>}
        </span>
        <span className="bar-value">
          <strong>{percentText(wins, games)}</strong> · {games}경기
        </span>
      </span>
      <span className="bar-track" aria-hidden="true">
        <span
          className={`bar-fill tone-${props.tone ?? "series"}`}
          style={{ width: `${percent(wins, games)}%` }}
        />
        <span className="bar-mid" />
      </span>
    </>
  );
  return props.onOpen ? (
    <button type="button" className="bar-row" title={detail} onClick={props.onOpen}>
      {body}
    </button>
  ) : (
    <div className="bar-row" title={detail}>
      {body}
    </div>
  );
}

/** 승률을 50% 기준 다섯 구간으로 나눈다. 5경기 미만은 색을 칠하지 않는다. */
function cellBand(tally: Tally): string {
  if (tally.games < SMALL_SAMPLE) return "band-none";
  const rate = percent(tally.wins, tally.games);
  if (rate < 40) return "band-low2";
  if (rate < 47.5) return "band-low1";
  if (rate <= 52.5) return "band-mid";
  if (rate <= 60) return "band-high1";
  return "band-high2";
}

/**
 * 그래프 분석. 기존 서비스의 네 가지를 옮겼다:
 * 개인별 승률, 라인별 승률, 진영별 누적 승률, 플레이어 × 라인.
 * 필터는 맨 위 한 줄에 모았고, 각 그래프 제목 아래에 어떤 필터가 적용되는지 적는다.
 */
export function Graphs(props: {
  snapshot: Snapshot;
  openPerson: (id: string) => void;
  back: () => void;
}) {
  const { snapshot } = props;
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [line, setLine] = useState<Position | "">("");
  const [playerId, setPlayerId] = useState("");
  const nameOf = nameMap(snapshot);

  const scopeLabel = scopeLabelOf(snapshot, scope);
  const years = matchYears(snapshot);
  const scoped = matchesInScope(snapshot, scope);
  const counted = scoped.filter((m) => m.state === "confirmed").length;
  // 배치와 칭호는 범위와 무관하게 전체 누적 기준이다.
  const placement = standingsOf(snapshot);

  const people = sortRanking(
    [...personRecordsByLine(scoped, line === "" ? null : line).values()],
    placement,
    nameOf,
  );
  const matrix = playerLineMatrix(scoped);
  const matrixRows = sortRanking([...personRecordsByLine(scoped, null).values()], placement, nameOf);
  const sides = sideTotals(scoped);
  const playerLines = playerId === "" ? null : (matrix.get(playerId) ?? {});
  const selectable = [...snapshot.participants]
    .filter((p) => matrixRows.some((r) => r.participantId === p.id))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));

  return (
    <div className="screen cols viz-root">
      <header className="screen-head">
        <BackLink label="← 기록" fallback={props.back} />
        <h1>그래프 분석</h1>
      </header>

      <div className="filter-row" role="group" aria-label="필터">
        <label>
          범위
          <select
            aria-label="범위"
            value={scopeValue(scope)}
            onChange={(e) => setScope(scopeFromValue(e.target.value))}
          >
            <option value="all">전체</option>
            <option value="today">오늘</option>
            {snapshot.seasons.map((s) => (
              <option key={s.id} value={`season:${s.id}`}>
                {s.name}
              </option>
            ))}
            {years.map((y) => (
              <option key={y} value={`year:${y}`}>
                {y}년
              </option>
            ))}
          </select>
        </label>
        <label>
          라인
          <select aria-label="라인" value={line} onChange={(e) => setLine(e.target.value as Position | "")}>
            <option value="">전체 라인</option>
            {POSITIONS.map((p) => (
              <option key={p} value={p}>
                {POSITION_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          플레이어
          <select aria-label="플레이어" value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
            <option value="">선택 안 함</option>
            {selectable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">
        {scopeLabel} · 확정 {counted}경기. 누적 {PLACEMENT_GAMES}경기 미만은 배치 진행 중이며
        배치 완료자 아래에 표시됩니다. 배치와 칭호는 범위와 관계없이 누적 기준입니다.
      </p>

      <section className="chart-card" aria-label="개인별 승률">
        <h2>개인별 승률</h2>
        <p className="hint">
          범위: {scopeLabel} · 라인: {line === "" ? "전체 라인" : POSITION_LABEL[line]} · 배치 완료
          먼저, 그 안에서 승률순
        </p>
        {people.length === 0 ? (
          <p className="hint">이 조건에는 기록이 없어요.</p>
        ) : (
          <ul className="bars">
            {people.map((r) => (
              <li key={r.participantId}>
                <RateBar
                  label={nameOf(r.participantId)}
                  note={standingText(placement.get(r.participantId))}
                  wins={r.wins}
                  games={r.games}
                  onOpen={() => props.openPerson(r.participantId)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="stack">
      <section className="chart-card" aria-label="라인별 승률">
        <h2>라인별 승률</h2>
        {playerLines === null ? (
          <p className="hint">
            위에서 플레이어를 고르면 그 사람의 라인별 승률을 보여줍니다. 전체 플레이어를 합치면 각
            경기마다 라인별로 1승·1패가 생겨 항상 50%이므로 보여주지 않습니다.
          </p>
        ) : (
          <>
            <p className="hint">
              범위: {scopeLabel} · 플레이어: {nameOf(playerId)}
            </p>
            <ul className="bars">
              {POSITIONS.map((position) => {
                const tally = playerLines[position];
                return (
                  <li key={position}>
                    {tally ? (
                      <RateBar
                        label={POSITION_LABEL[position]}
                        note={tally.games < SMALL_SAMPLE ? "자료 적음" : undefined}
                        wins={tally.wins}
                        games={tally.games}
                      />
                    ) : (
                      <div className="bar-row">
                        <span className="bar-head">
                          <span className="name">{POSITION_LABEL[position]}</span>
                          <span className="bar-value">기록 없음</span>
                        </span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      <section className="chart-card" aria-label="진영별 누적 승률">
        <h2>진영별 누적 승률</h2>
        <p className="hint">
          범위: {scopeLabel} · 결과를 저장할 때 확인한 실제 진영 기준입니다.
        </p>
        {sides.known === 0 ? (
          <p className="hint">진영을 아는 경기가 없어요.</p>
        ) : (
          <ul className="bars">
            <li>
              <RateBar label="블루" wins={sides.blueWins} games={sides.known} tone="blue" />
            </li>
            <li>
              <RateBar label="레드" wins={sides.redWins} games={sides.known} tone="red" />
            </li>
          </ul>
        )}
        {sides.unknown > 0 && (
          <p className="hint">진영 미상 {sides.unknown}경기는 제외했습니다.</p>
        )}
      </section>
      </div>

      <section className="chart-card full" aria-label="플레이어 × 라인">
        <h2>플레이어 × 라인</h2>
        <p className="hint">
          범위: {scopeLabel} · 위 숫자는 승률, 아래 숫자는 경기 수 · — 는 기록 없음
        </p>
        <ul className="legend" aria-label="색 범례">
          <li>
            <span className="swatch band-low2" /> 40% 미만
          </li>
          <li>
            <span className="swatch band-low1" /> 40~47%
          </li>
          <li>
            <span className="swatch band-mid" /> 50% 안팎
          </li>
          <li>
            <span className="swatch band-high1" /> 53~60%
          </li>
          <li>
            <span className="swatch band-high2" /> 60% 초과
          </li>
          <li>
            <span className="swatch band-none" /> {SMALL_SAMPLE}경기 미만(색 없음)
          </li>
        </ul>
        {matrixRows.length === 0 ? (
          <p className="hint">이 범위에는 기록이 없어요.</p>
        ) : (
          <table className="matrix">
            <thead>
              <tr>
                <th scope="col">이름</th>
                {POSITIONS.map((p) => (
                  <th key={p} scope="col">
                    {POSITION_LABEL[p]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrixRows.map((r) => {
                const row = matrix.get(r.participantId) ?? {};
                return (
                  <tr key={r.participantId} className={r.participantId === playerId ? "picked" : undefined}>
                    <th scope="row" title={nameOf(r.participantId)}>
                      {nameOf(r.participantId)}
                    </th>
                    {POSITIONS.map((position) => {
                      const tally = row[position];
                      return tally ? (
                        <td
                          key={position}
                          className={cellBand(tally)}
                          title={`${nameOf(r.participantId)} ${POSITION_LABEL[position]}: ${tally.wins}승 ${tally.games - tally.wins}패`}
                        >
                          {Math.round(percent(tally.wins, tally.games))}%
                          <br />
                          <span className="cell-games">{tally.games}</span>
                        </td>
                      ) : (
                        <td key={position} className="band-empty" aria-label="기록 없음">
                          —
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
