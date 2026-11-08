import { RANKING_VETERAN_GAMES, sortRankingBy } from "../../shared/insights";
import { useState, type ReactNode } from "react";
import { matchesInScope, matchYears, personRecordsByLine, PLACEMENT_GAMES, scopeLabel as scopeLabelOf, playerLineMatrix, sideTotals, SMALL_SAMPLE, type Scope, type Tally, type PersonRecord } from "../../shared/stats";
import { POSITIONS, type Position, type Snapshot } from "../../shared/types";
import { heatBarClass, nameMap, rateTier, POSITION_LABEL, RATE_HEAT_COLD, RATE_HEAT_HOT, standingsOf, type ShownStanding } from "../format";
import { BackLink, PosLabel, scopeFromValue, scopeValue, TitleBadge } from "../ui";

/** 막대 옆 짧은 표시: 배치 중이면 "배치 진행 중", 완료자는 칭호(누적 기준). */
function standingText(standing: ShownStanding | undefined): ReactNode {
  if (!standing?.done) return "배치 진행 중";
  return standing.title ? (
    <>
      <TitleBadge name={standing.title} grade={standing.grade} />
      (누적)
    </>
  ) : undefined;
}

function percent(wins: number, games: number): number {
  return games === 0 ? 0 : (wins / games) * 100;
}

/** 다른 화면과 같은 정수 승률(예전에는 소수 한 자리였다. 2026-11-08 통일). */
function percentText(wins: number, games: number): string {
  return `${Math.round(percent(wins, games))}%`;
}

/**
 * 승률 막대 한 줄. 0~100% 한 축이고 50% 위치에 기준선을 둔다.
 * 값은 글자로 함께 쓰고(색에만 의존하지 않음), 글자는 막대와 같은 승률 색 단계를 따른다.
 * series(승률) 막대만 색 단계를 따르고 5경기 미만은 회색이다. 진영 막대(blue·red)는 진영 색 그대로.
 */
function RateBar(props: {
  label: string;
  note?: ReactNode;
  wins: number;
  games: number;
  tone?: "series" | "blue" | "red";
  onOpen?: () => void;
}) {
  const { wins, games } = props;
  const tone = props.tone ?? "series";
  const fill = tone !== "series" ? `tone-${tone}` : games < SMALL_SAMPLE ? "tone-muted" : `tone-series ${heatBarClass(wins, games)}`;
  const detail = `${props.label}: ${percentText(wins, games)} · ${wins}승 ${games - wins}패 (${games}경기)`;
  const body = (
    <>
      <span className="bar-head">
        <span className="name">
          {props.label}
          {props.note && <span className="bar-note"> · {props.note}</span>}
        </span>
        <span className="bar-value">
          {games === 0 ? (
            <span className="bar-empty">—</span>
          ) : (
            <>
              <strong className={tone === "series" ? rateTier(wins, games) : undefined}>
                {percentText(wins, games)}
              </strong>{" "}
              · {wins}승 {games - wins}패 ({games}경기)
            </>
          )}
          {tone === "series" && games > 0 && games < SMALL_SAMPLE && (
            <>
              {" "}
              <span className="tag" title={`${SMALL_SAMPLE}경기 미만은 승률에 색을 칠하지 않아요`}>
                자료 적음
              </span>
            </>
          )}
        </span>
      </span>
      <span className="bar-track" aria-hidden="true">
        <span
          className={`bar-fill ${fill}`}
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

/** 표 칸의 색: 막대와 같은 승률 색 단계(heatBarClass). 5경기 미만은 색을 칠하지 않는다. */
function cellBand(tally: Tally): string {
  return heatBarClass(tally.wins, tally.games) || "band-none";
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

  // 랭킹 화면과 같은 묶음 순서(2026-11-08): 누적 50경기 이상 → 배치 완료(50경기 미만) → 배치 진행 중, 그 안에서 승률순.
  // 배치를 마쳤어도 50경기 미만이면 50경기 이상인 사람보다 항상 아래에 선다.
  // 이 범위·라인에서 5경기 미만(색을 칠하지 않는 "자료 적음")인 사람은 묶음과 무관하게 맨 아래로(2026-11-08).
  // 라인별로 보면 누적이 많은 사람도 그 라인은 한두 경기라 100%·0%가 섞여 들어가 위에 서는 것을 막는다.
  const withSample = (rows: PersonRecord[]) =>
    rows.sort((a, b) => Number(a.games < SMALL_SAMPLE) - Number(b.games < SMALL_SAMPLE));
  const people = withSample(
    sortRankingBy([...personRecordsByLine(scoped, line === "" ? null : line).values()], placement, nameOf, "rate"),
  );
  const matrix = playerLineMatrix(scoped);
  const matrixRows = withSample(
    sortRankingBy([...personRecordsByLine(scoped, null).values()], placement, nameOf, "rate"),
  );
  // 표에서 색 칸(어느 라인이든 5경기 이상)이 하나도 없는 사람은 "자료 적음" 접힘으로 보낸다.
  const hasColoredCell = (id: string) => {
    const row = matrix.get(id) ?? {};
    return POSITIONS.some((p) => (row[p]?.games ?? 0) >= SMALL_SAMPLE);
  };
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
        {scopeLabel} · 확정 {counted}경기. 순서는 누적 {RANKING_VETERAN_GAMES}경기 이상 → 배치 완료({PLACEMENT_GAMES}경기 이상) →
        배치 진행 중이고, 그 안에서 승률순입니다. 배치와 칭호는 범위와 관계없이 누적 기준입니다.
      </p>

      {/* 플레이어를 고르면 그 사람의 라인별 승률을 맨 위(개인별 승률 위)에 보인다(2026-11-08). 좁은 화면에서 고른 뒤
          아래로 한참 내려가지 않아도 되고, 넓은 화면에서는 두 단을 가로질러 위에 놓인다. */}
      {playerLines !== null && (
      <section className={playerLines === null ? "chart-card" : "chart-card line-first"} aria-label="라인별 승률">
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
                      <RateBar label={POSITION_LABEL[position]} wins={tally.wins} games={tally.games} />
                    ) : (
                      // 기록이 없어도 같은 높이의 빈 막대를 둔다(PC 5칸 가로 배치에서 줄이 깨지지 않게).
                      <RateBar label={POSITION_LABEL[position]} note="기록 없음" wins={0} games={0} />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
      )}

      <section className="chart-card" aria-label="개인별 승률">
        <h2>개인별 승률</h2>
        <p className="hint">
          범위: {scopeLabel} · 라인: {line === "" ? "전체 라인" : POSITION_LABEL[line]} · 누적{" "}
          {RANKING_VETERAN_GAMES}경기 이상 → 배치 완료 → 배치 진행 중, 그 안에서 승률순 · {SMALL_SAMPLE}경기 미만은 맨 아래
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
      {playerLines === null && (
        <section className="chart-card" aria-label="라인별 승률">
          <h2>라인별 승률</h2>
          <p className="hint">
            위에서 플레이어를 고르면 그 사람의 라인별 승률을 맨 위에 보여줍니다. 전체 플레이어를 합치면 각 경기마다
            라인별로 1승·1패가 생겨 항상 50%이므로 보여주지 않습니다.
          </p>
        </section>
      )}

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
        <HeatLegend />
        {matrixRows.length === 0 ? (
          <p className="hint">이 범위에는 기록이 없어요.</p>
        ) : (
          <>
            <MatrixTable
              rows={matrixRows.filter((r) => hasColoredCell(r.participantId))}
              matrix={matrix}
              nameOf={nameOf}
              playerId={playerId}
              openPerson={props.openPerson}
            />
            {matrixRows.some((r) => !hasColoredCell(r.participantId)) && (
              <details className="matrix-few">
                <summary>
                  어느 라인도 {SMALL_SAMPLE}경기 미만 · {matrixRows.filter((r) => !hasColoredCell(r.participantId)).length}명(자료
                  적음)
                </summary>
                <MatrixTable
                  rows={matrixRows.filter((r) => !hasColoredCell(r.participantId))}
                  matrix={matrix}
                  nameOf={nameOf}
                  playerId={playerId}
                  openPerson={props.openPerson}
                />
              </details>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** 승률 색 범례: 한 줄 띠. 낮은 쪽(30%↓)에서 높은 쪽(70%↑)까지 열 칸, 그 뒤 5경기 미만. 막대 그래프와 표가 같이 쓴다. */
function HeatLegend() {
  const bands: { cls: string; label: string }[] = [
    { cls: "heat-l4", label: `${RATE_HEAT_COLD[3]}%↓` },
    { cls: "heat-l3", label: "" },
    { cls: "heat-l2", label: "" },
    { cls: "heat-l1", label: "" },
    { cls: "heat-0 mid-lo", label: `${RATE_HEAT_COLD[0]}%` },
    { cls: "heat-0 mid-hi", label: "50%" },
    { cls: "heat-h1", label: `${RATE_HEAT_HOT[0]}%` },
    { cls: "heat-h2", label: "" },
    { cls: "heat-h3", label: "" },
    { cls: "heat-h4", label: `${RATE_HEAT_HOT[3]}%↑` },
  ];
  return (
    <div className="legend-strip" role="img" aria-label="색 범례: 낮은 승률은 회색·갈색·자주·보라, 기준은 파랑·청록, 높은 승률은 연두·노랑·주황·빨강. 5경기 미만은 색 없음">
      <span className="legend-low">낮음</span>
      <span className="legend-bands">
        {bands.map((b) => (
          <span key={b.cls} className={`swatch ${b.cls}`} title={b.label || undefined}>
            {b.label && <span className="legend-tick">{b.label}</span>}
          </span>
        ))}
      </span>
      <span className="legend-high">높음</span>
      <span className="legend-none">
        <span className="swatch band-none" /> {SMALL_SAMPLE}경기 미만
      </span>
    </div>
  );
}

/**
 * 플레이어 × 라인 표. 머리 행은 화면을 내려도 붙어 있고(sticky), 라인에는 아이콘, 이름은 개인 통계로 가는 버튼이다.
 * 칸은 승률(굵게)과 경기 수(작게). 색은 막대와 같은 단계(heatBarClass): 옅은 바탕 + 왼쪽 진한 띠.
 */
function MatrixTable(props: {
  rows: PersonRecord[];
  matrix: ReturnType<typeof playerLineMatrix>;
  nameOf: (id: string) => string;
  playerId: string;
  openPerson: (id: string) => void;
}) {
  const { rows, matrix, nameOf, playerId } = props;
  if (rows.length === 0) return null;
  return (
    <table className="matrix">
      <thead>
        <tr>
          <th scope="col">이름</th>
          {POSITIONS.map((p) => (
            <th key={p} scope="col">
              <PosLabel position={p} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const row = matrix.get(r.participantId) ?? {};
          return (
            <tr key={r.participantId} className={r.participantId === playerId ? "picked" : undefined}>
              <th scope="row" title={nameOf(r.participantId)}>
                <button type="button" className="matrix-name" onClick={() => props.openPerson(r.participantId)}>
                  {nameOf(r.participantId)}
                </button>
              </th>
              {POSITIONS.map((position) => {
                const tally = row[position];
                return tally ? (
                  <td
                    key={position}
                    className={cellBand(tally)}
                    title={`${nameOf(r.participantId)} ${POSITION_LABEL[position]}: ${tally.wins}승 ${tally.games - tally.wins}패`}
                  >
                    <strong className="cell-rate">{Math.round(percent(tally.wins, tally.games))}%</strong>
                    <span className="cell-games">{tally.games}경기</span>
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
  );
}
