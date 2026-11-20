// 그래프 분석(Graphs.tsx)의 승률 막대·플레이어 × 라인 표·승률 색 범례. 고른 플레이어 묶음(graphProfile.tsx)은 쓰지 않는다.
import type { ReactNode } from "react";
import { ratePercent, SMALL_SAMPLE, type PersonRecord, type playerLineMatrix, type Tally } from "../../shared/stats";
import { POSITIONS } from "../../shared/types";
import { heatClass, PEOPLE_BAR_STEPS, percentText, POSITION_LABEL, rateHueClass, rateTier, type ShownStanding } from "../format";
import { PosLabel, TitleBadge } from "../screenKit";

/** 막대 옆 짧은 표시: 배치 중이면 "배치 진행 중", 완료자는 칭호. 누적 기준이라는 말은 목록 위 안내에 한 번만 쓴다. */
export function standingText(standing: ShownStanding | undefined): ReactNode {
  if (!standing?.done) return "배치 진행 중";
  return standing.title ? <TitleBadge name={standing.title} grade={standing.grade} compact /> : undefined;
}

function percent(wins: number, games: number): number {
  return games === 0 ? 0 : (wins / games) * 100;
}

/**
 * 승률 막대 한 줄. 0~100% 한 축이고 50% 위치에 기준선을 둔다.
 * 값은 글자로 함께 쓰고(색에만 의존하지 않음), 글자는 막대와 같은 승률 3단 색을 따른다.
 * series(승률) 막대만 3단 색을 따르고 5경기 미만은 속 빈 테두리 막대 + "자료 적음" 글자다. 진영 막대(blue·red)는 진영 색 그대로.
 */
export function RateBar(props: {
  label: string;
  note?: ReactNode;
  wins: number;
  games: number;
  tone?: "series" | "blue" | "red";
  /** 개인별·라인별 승률 막대: 막대와 숫자를 승률 여섯 색(rateHueClass, 플레이어 × 라인 칸과 같다)으로. */
  hued?: boolean;
  /** 위에서 고른 플레이어의 줄(강조). */
  picked?: boolean;
  onOpen?: () => void;
}) {
  const { wins, games } = props;
  const tone = props.tone ?? "series";
  const fill =
    tone !== "series"
      ? `tone-${tone}`
      : games < SMALL_SAMPLE
        ? "tone-muted"
        : `tone-series ${props.hued ? rateHueClass(wins, games) : heatClass(wins, games)}`;
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
              <strong className={tone !== "series" ? undefined : props.hued && games >= SMALL_SAMPLE ? `rate ${rateHueClass(wins, games)}` : rateTier(wins, games)}>
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
  const rowClass = props.picked ? "bar-row picked" : "bar-row";
  return props.onOpen ? (
    <button type="button" className={rowClass} title={detail} onClick={props.onOpen}>
      {body}
    </button>
  ) : (
    <div className={rowClass} title={detail}>
      {body}
    </div>
  );
}

/** 표 칸 클래스: heat(칸 바탕이 있는지)와 승률 여섯 색(rate-hue). 5경기 미만은 band-none(바탕·색 없음). */
function cellBand(tally: Tally): string {
  const heat = heatClass(tally.wins, tally.games);
  return heat ? `${heat} ${rateHueClass(tally.wins, tally.games)}` : "band-none";
}

/**
 * 승률 여섯 색 범례(rate-hue): 개인별 승률·플레이어 × 라인에 둔다. 견본·칸 숫자·막대가 같은 색이다.
 */
export function StepLegend() {
  const edges = PEOPLE_BAR_STEPS;
  const bands = [
    { cls: "rate-hue-1", label: `${edges[0]}% 미만` },
    ...edges.slice(0, -1).map((edge, i) => ({ cls: `rate-hue-${i + 2}`, label: `${edge}~${edges[i + 1]! - 1}%` })),
    { cls: `rate-hue-${edges.length + 1}`, label: `${edges[edges.length - 1]}% 이상` },
  ];
  return (
    <ul className="legend" aria-label="승률 색 범례">
      {bands.map((b) => (
        <li key={b.cls}>
          <span className={`swatch ${b.cls}`} aria-hidden="true" />
          {b.label}
        </li>
      ))}
      <li>
        <span className="swatch band-none" aria-hidden="true" />
        {SMALL_SAMPLE}경기 미만 (색 없음)
      </li>
    </ul>
  );
}

/**
 * 플레이어 × 라인 표. 머리 행은 화면을 내려도 붙어 있고(sticky), 라인에는 아이콘, 이름은 개인 통계로 가는 버튼이다.
 * 칸은 승률(굵게)과 경기 수(작게). 바탕은 모든 칸이 같은 중립색이고 승률 글자만 막대와 같은 3단 색이다.
 */
export function MatrixTable(props: {
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
            // 행 전체를 눌러 개인 통계로 간다(이름 글자만 누르기에는 작다, 2026-11-08). 키보드는 이름 버튼으로.
            <tr
              key={r.participantId}
              className={r.participantId === playerId ? "matrix-row picked" : "matrix-row"}
              onClick={() => props.openPerson(r.participantId)}
            >
              <th scope="row" title={nameOf(r.participantId)}>
                <button
                  type="button"
                  className="matrix-name"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.openPerson(r.participantId);
                  }}
                >
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
                    <strong className="cell-rate">{ratePercent(tally.wins, tally.games)}%</strong>
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
