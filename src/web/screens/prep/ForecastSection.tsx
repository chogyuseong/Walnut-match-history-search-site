// 준비 화면 예상 승률 판(2026-11-09 추가). 블루·레드 예상 승률 막대와 그 이유(라인에 선 두 사람의 전체 MMR 차), 맨 아래 접힌 티어 점수.
// Prep.tsx가 쓰며, 예전의 "라인 맞대결"·"편성 균형" 두 구역을 이 판 하나로 합쳤다.
// 숫자는 src/shared/forecast.ts(스냅숏 경기로 기기에서 계산), 티어 점수는 prepTools.ts draftBalance(운영자에게만 넘어온다).
import {
  balanceText,
  matchupText,
  splitRanksText,
  type DraftBalance,
  type DraftSplitRanks,
} from "../../../shared/prepTools";
import {
  favoriteOf,
  forecastBluePercent,
  forecastSummaryText,
  FULL_PERCENT,
  LANE_EDGE_MIN,
  type DraftForecast,
  type ForecastPerson,
  type LaneForecast,
} from "../../../shared/forecast";
import { priorityLabel } from "../../../shared/priority";
import { shownRating } from "../../../shared/rating";
import { ratePercent } from "../../../shared/stats";
import type { Team } from "../../../shared/types";
import { CALIBRATION_MIN_GAMES } from "../../../shared/upset";
import { POSITION_LABEL } from "../../format";
import { Help, InfoTip, PosLabel } from "../../screenKit";
import { prepTeamName } from "./common";

/** 팀 상자(.team.side-blue/red)와 같은 색을 쓰도록 styles.css .fc-tone-A/B가 변수를 잡는다. */
const TONE: Record<Team, string> = { A: "fc-tone-A", B: "fc-tone-B" };
const SHORT_TEAM: Record<Team, string> = { A: "블루", B: "레드" };

/**
 * 접지 않는다: 접혀 있던 "편성 균형"을 아무도 열어 보지 않았다는 피드백에서 나온 판이다.
 * balance는 운영자가 아니면 null이라 티어 점수 부분이 통째로 빠진다.
 */
export function ForecastSection(props: {
  forecast: DraftForecast;
  nameOf: (key: string) => string;
  balance: DraftBalance | null;
  /** 직전 편성(되돌리기 이력)의 티어 점수. 운영자이고 직전 편성이 있을 때만. 차가 달라졌을 때 한 줄로 쓴다. */
  previousBalance?: DraftBalance | null;
  placementGames: number;
  /** MMR 시작값(모임 설정). 연결 안 된 사람을 이 값으로 계산한다. */
  start: number;
  /** 같은 10명의 나누기 중 지금 편성의 균형 순위(prepTools.ts draftSplitRanks). 티어 순위는 balance와 같은 조건(운영자)에서만. */
  splitRanks?: DraftSplitRanks | null;
}) {
  const { forecast, nameOf, balance, placementGames } = props;
  const names: [string, string] = [prepTeamName("A"), prepTeamName("B")];
  const blue = forecastBluePercent(forecast);
  const red = FULL_PERCENT - blue;
  const fav = forecast.reliable ? favoriteOf(forecast) : null;
  const { A, B } = forecast.teams;
  const unknown = A.unknown + B.unknown;
  // 예상의 근거가 몇 명의 기록인지. 판정 기준(한 명이라도 배치 완료면 표시)은 그대로 두고 숫자만 드러낸다.
  // 연결 안 된 사람도 분모에 넣는다: 그 사람도 시작값으로 계산에 들어가기 때문이다.
  const seated = A.size + B.size;
  const placed = seated - (A.placement + B.placement) - unknown;

  return (
    <section className="prep-tools forecast" aria-label="예상 승률">
      <h2>
        예상 승률{" "}
        <InfoTip label="예상 승률">
          지난 경기 기록으로 쌓인 각자의 내전 MMR(라인을 나누지 않은 전체 점수)로 낸 추정이에요. 팀을 티어로 맞춰 짜는
          모임에서는 MMR 차만으로 낸 확률이 실제보다 한쪽으로 쏠려서, 이 모임 지난 경기의 예상과 실제 결과를 견줘 쏠림을
          줄이고 블루·레드 진영 차이를 더해 보정해요. 판정할 수 있는 지난 경기가 {CALIBRATION_MIN_GAMES}경기가 안 되면
          보정하지 않아요. 경기 뒤 "이변" 판정도 같은 보정값을 써요. 라인 비교는 그 라인에 선 두 사람의 전체 MMR을 견준
          것이라, 처음 맡는 라인의 실력은 반영하지 않아요. 팀을 나눌 때는 쓰지 않고(팀은 티어로 나눠요), 짠 팀이 얼마나
          비슷한지 확인할 때 봐요. 아래 "몇 가지 중 몇 위"는 같은 10명을 5:5로 나눌 수 있는 모든 방법과 견준 자리예요.
          1위면 이 10명으로 이보다 고르게 나눌 방법이 없다는 뜻이고, 이길 확률은 아니에요.
        </InfoTip>
      </h2>
      <p className={`forecast-summary${fav ? ` ${TONE[fav]}` : ""}`}>
        <strong>{forecastSummaryText(forecast, names)}</strong>
      </p>

      {/* ─ 블루:레드 막대. 레드는 100 − 블루로 써서 합이 늘 100이다 ─ */}
      <div
        className={`forecast-bar${forecast.reliable ? "" : " muted"}`}
        role="img"
        aria-label={`${names[0]} ${blue}% : ${names[1]} ${red}%`}
      >
        <span className="fc-seg fc-tone-A" style={{ flexGrow: blue }}>
          블루 {blue}%
        </span>
        <span className="fc-seg fc-tone-B" style={{ flexGrow: red }}>
          레드 {red}%
        </span>
        <span className="fc-mid" aria-hidden="true" />
      </div>
      <p className="hint">
        팀 평균 MMR {shownRating(A.average)} : {shownRating(B.average)}
        {seated > 0 && ` · 배치 완료 ${placed}/${seated}명`}
        {unknown > 0 && ` · 연결 안 된 사람 ${unknown}명(${props.start}으로 계산)`}
        {forecast.calibration.applied
          ? ` · 이 모임 ${forecast.calibration.games}경기로 보정`
          : ` · 보정 전(지난 경기 ${forecast.calibration.games}/${CALIBRATION_MIN_GAMES})`}
      </p>
      {props.splitRanks?.mmr && <p className="hint">{splitRanksText(props.splitRanks)}</p>}

      {/* ─ 라인별 표. 칸 배치는 판 폭에 따라 CSS 컨테이너 쿼리가 바꾼다(.fc-lane) ─ */}
      <ul className="list list-card forecast-lanes" aria-label="라인별 우위">
        {forecast.lanes.map((lane) => (
          <li key={lane.position} className="fc-lane" title={laneTitle(lane, nameOf)}>
            <span className="fc-pos">
              <PosLabel position={lane.position} />
            </span>
            <EdgeChip lane={lane} />
            <PersonCell person={lane.blue} side="A" position={lane.position} nameOf={nameOf} placementGames={placementGames} />
            <PersonCell person={lane.red} side="B" position={lane.position} nameOf={nameOf} placementGames={placementGames} />
            <span className="fc-h2h">맞대결 {matchupText(lane)}</span>
          </li>
        ))}
      </ul>

      {/* ─ 티어 점수: 운영자만. 예상의 이유가 아니라 참고라 접어 둔다 ─ */}
      {balance && (
        <details>
          <summary>티어 점수 보기</summary>
          <p>
            {names[0]} 티어 점수 {balance.sumA} · {names[1]} {balance.sumB} ·{" "}
            <strong>{balanceText(balance, names)}</strong>
          </p>
          {/* 티어 색은 팀 추천 창의 .cand-tier를 빌려 쓴다(같은 티어가 화면마다 다른 색이면 헷갈린다). */}
          <ul className="list viz-root" aria-label="티어별 인원">
            {balance.counts.map((row) => (
              <li key={row.priority ?? "none"} className="list-row static">
                <span className={row.priority === null ? "cand-tier none" : `cand-tier t${row.priority}`}>
                  {priorityLabel(row.priority)}
                </span>
                <span className="stat tier-count">
                  <span className={row.a === 0 ? "tc-blue zero" : "tc-blue"}>블루 {row.a}</span> ·{" "}
                  <span className={row.b === 0 ? "tc-red zero" : "tc-red"}>레드 {row.b}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="hint">
            {props.previousBalance && balance.assigned > 0 && props.previousBalance.diff !== balance.diff && (
              <>
                직전 편성 대비 티어 점수 차(블루 − 레드) {props.previousBalance.diff} → {balance.diff}.{" "}
              </>
            )}
            {balance.assigned === 0
              ? "티어를 정한 사람이 없어 점수가 모두 0이에요."
              : "점수는 균형 팀 추천과 같은 방식이에요(티어 가중치, 미지정은 정한 사람들의 가운데 값)."}{" "}
            티어는 운영자에게만 보이고 편성 이미지에는 넣지 않아요.
          </p>
        </details>
      )}

      <p className="hint">
        예상은 팀 MMR 평균 차로 구한 승률을 이 모임 지난 경기 결과에 맞춰 보정한 값이에요. 라인 우위는 두 사람 MMR 차{" "}
        {LANE_EDGE_MIN} 이상일 때 표시해요.
      </p>
      {/* 줄마다의 title 풍선은 터치 화면에서 뜨지 않아 같은 글을 접힌 도움말에도 둔다. */}
      <Help label="라인별 계산 보기">
        {forecast.lanes.map((lane) => (
          <p key={lane.position}>{laneTitle(lane, nameOf)}</p>
        ))}
      </Help>
    </section>
  );
}

/** 한쪽 자리가 비면 "비슷"이 아니라 "-"다. 비교 자체를 안 했다는 뜻이라 둘을 구분한다. */
function EdgeChip(props: { lane: LaneForecast }) {
  const { lane } = props;
  if (lane.edge === null) return <span className="fc-edge">-</span>;
  if (!lane.edgeTeam) return <span className="fc-edge">비슷</span>;
  return (
    <span className={`fc-edge ${TONE[lane.edgeTeam]}`}>
      {SHORT_TEAM[lane.edgeTeam]} +{shownRating(Math.abs(lane.edge))}
    </span>
  );
}

/**
 * 연결 없는 사람은 계산에는 시작값으로 들어가지만 칸에는 "기록 없음"이라 쓴다. 시작값을 적으면 실력이 그 정도라는 오해를 산다.
 * "배치 중"은 MMR이 아직 크게 출렁인다는 표시다.
 */
function PersonCell(props: {
  person: ForecastPerson | null;
  side: Team;
  position: LaneForecast["position"];
  nameOf: (key: string) => string;
  placementGames: number;
}) {
  const { person, side, position, nameOf, placementGames } = props;
  const cls = `fc-person fc-side-${side}`;
  if (!person) return <span className={cls}>(비어 있음)</span>;
  const lineName = POSITION_LABEL[position];
  const line = person.line;
  return (
    <span className={cls}>
      <span className="fc-name">
        <span className={`fc-dot ${TONE[side]}`} aria-hidden="true" />
        <span className="sr-only">{SHORT_TEAM[side]} </span>
        {nameOf(person.key)}
      </span>
      <span className="fc-sub">
        {person.participantId === null ? "기록 없음" : `MMR ${shownRating(person.rating)}`}
        {person.participantId !== null && person.games < placementGames && " · 배치 중"}
        {" · "}
        {line.games === 0
          ? `${lineName} 첫 경기`
          : `${lineName} ${ratePercent(line.wins, line.games)}% (${line.games}경기)`}
      </span>
    </span>
  );
}

/** 칩만 보고는 기준을 알 수 없어서, 줄에 손을 올리면 두 사람 MMR과 우위 기준을 글로 보여 준다. */
function laneTitle(lane: LaneForecast, nameOf: (key: string) => string): string {
  const lineName = POSITION_LABEL[lane.position];
  if (!lane.blue || !lane.red || lane.edge === null) return `${lineName}: 한쪽 자리가 비어 우위를 비교하지 않아요.`;
  const who = (p: ForecastPerson) => `${nameOf(p.key)} MMR ${shownRating(p.rating)}`;
  const verdict = lane.edgeTeam
    ? `차 ${shownRating(Math.abs(lane.edge))}로 ${prepTeamName(lane.edgeTeam)} 우위`
    : `차 ${shownRating(Math.abs(lane.edge))}로 비슷(${LANE_EDGE_MIN} 미만)`;
  return `${lineName}: 블루 ${who(lane.blue)}, 레드 ${who(lane.red)}. ${verdict}.`;
}
