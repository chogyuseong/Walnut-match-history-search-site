import { useMemo, type ReactNode } from "react";
import { memoOneLine } from "../shared/memo";
import { ratingOptionsOf } from "../shared/rating";
import { isCounted } from "../shared/stats";
import { POSITIONS, TEAMS, type MatchView, type Snapshot, type Team } from "../shared/types";
import { matchExpectations, type MatchExpectation } from "../shared/upset";
import {
  formatDate,
  formatTime,
  knownSideOf,
  sideColorOf,
  matchTone,
  POSITION_LABEL,
  resultLine,
  SIDE_LABEL,
  TEAM_MARK,
  teamName,
  teamRoster,
} from "./format";
import { PosLabel } from "./screenKit";

/**
 * 경기 카드. 기록 목록·홈·개인 통계·비교가 함께 쓴다.
 * - 맨 위 줄(경기 번호·결과·시각)이 경기 상세로 가는 버튼이고, 카드의 빈 곳을 눌러도 같은 곳으로 간다.
 * - 이름은 따로 누를 수 있는 버튼이며 그 사람의 개인 통계로 간다.
 * - 두 팀은 한 줄씩(위: 팀 A, 아래: 팀 B). 포지션이 모두 있으면 라인 순서로 칸을 맞추고 위에 라인 이름을 둔다.
 *   줄 머리는 진영이 정해진 경기면 "블루"/"레드", 모르면 "●A"/"■B"(팀 이름 규칙 teamName과 같다).
 * - 색: 전체 목록은 이긴 팀의 진영, 개인 화면(focusId)은 그 사람의 승·패. 미확정·진영 미상은 색 없음.
 *   승·패는 글자로도 적어 색만으로 구분하지 않는다.
 */
export function MatchCard(props: {
  match: MatchView;
  nameOf: (id: string) => string;
  timeZone: string;
  onOpen: () => void;
  onPerson: (id: string) => void;
  /** 개인 화면: 이 사람의 승패로 색을 입히고 이름을 강조한다. */
  focusId?: string | null;
  /** 비교 화면: 함께 강조할 사람들. */
  highlightIds?: readonly string[];
  /** 날짜를 함께 쓸지(오늘 목록에서는 시각만). */
  showDate?: boolean;
  /** 카드 머리 오른쪽에 둘 동작(예: 결과 입력). */
  action?: ReactNode;
  /** 이 경기가 속한 시리즈의 짧은 표시(예: "결승 · 2:1"). 없으면 배지를 그리지 않는다. */
  seriesBadge?: string | null;
  /** 이변 경기면 "이변" 배지를 붙인다(src/shared/upset.ts, useExpectations). */
  upset?: boolean;
}) {
  const { match, nameOf, focusId } = props;
  const confirmed = isCounted(match);
  const me = focusId ? (match.roster.find((r) => r.participantId === focusId) ?? null) : null;
  const myWin = me && confirmed ? me.team === match.winnerTeam : null;
  const tone = focusId ? (myWin === null ? "none" : myWin ? "win" : "loss") : matchTone(match);
  const withPositions = match.roster.length > 0 && match.roster.every((r) => r.position !== null);
  const highlight = new Set(props.highlightIds ?? []);
  if (focusId) highlight.add(focusId);
  const when = `${props.showDate ? `${formatDate(match.playedAt, props.timeZone)} ` : ""}${formatTime(match.playedAt, props.timeZone)}`;

  return (
    <li className={`match-card match-row tone-${tone}${match.state === "excluded" ? " is-excluded" : ""}`}>
      <div className="mc-head">
        <button type="button" className="mc-main" onClick={props.onOpen}>
          <span className="mc-title">
            {myWin !== null && (
              <span className={myWin ? "mc-result result-win" : "mc-result result-loss"}>
                {myWin ? "승" : "패"}
              </span>
            )}
            <span>
              {match.matchNo}경기 · {resultLine(match)}
            </span>
          </span>
          <span className="mc-when">{when}</span>
        </button>
        {props.action && <span className="mc-action">{props.action}</span>}
      </div>
      {(props.seriesBadge || props.upset || match.memo) && (
        // 시리즈·이변 배지와 메모 한 줄(넘치면 말줄임). 메모는 글자로만 그린다(HTML로 해석하지 않음).
        <p className="mc-extra">
          {props.upset && (
            <span className="series-badge" title="경기 전 예상이 약팀이던 쪽이 이겼어요">
              이변
            </span>
          )}
          {props.seriesBadge && <span className="series-badge">{props.seriesBadge}</span>}
          {match.memo && (
            <span className="mc-memo" title={match.memo}>
              <span className="mc-memo-label">메모</span> 
              {memoOneLine(match.memo)}
            </span>
          )}
        </p>
      )}
      <div className={withPositions ? "mc-grid with-pos" : "mc-grid"}>
        {withPositions && (
          <div className="mc-roles" aria-hidden="true">
            <span />
            {POSITIONS.map((p) => (
              <span key={p} className="mc-role">
                <PosLabel position={p} />
              </span>
            ))}
          </div>
        )}
        {TEAMS.map((team) => (
          <TeamLine
            key={team}
            match={match}
            team={team}
            nameOf={nameOf}
            highlight={highlight}
            onPerson={props.onPerson}
            withPositions={withPositions}
          />
        ))}
      </div>
    </li>
  );
}

function TeamLine(props: {
  match: MatchView;
  team: Team;
  nameOf: (id: string) => string;
  highlight: ReadonlySet<string>;
  onPerson: (id: string) => void;
  withPositions: boolean;
}) {
  const { match, team } = props;
  const confirmed = isCounted(match);
  const won = confirmed ? match.winnerTeam === team : null;
  const side = knownSideOf(team, match.teamASide);
  const label = `${teamName(team, match.teamASide)}${won === null ? "" : won ? " 승리" : " 패배"}`;
  return (
    <div
      className={won === null ? "mc-team" : won ? "mc-team is-win" : "mc-team is-loss"}
      role="group"
      aria-label={label}
    >
      <span className="mc-team-label" aria-hidden="true">
        <span className={`mc-team-name side-${sideColorOf(team, match.teamASide)}`}>
          {side ? (
            SIDE_LABEL[side]
          ) : (
            <>
              {TEAM_MARK[team]}
              {team}
            </>
          )}
        </span>
        {won !== null && <span className="mc-team-result">{won ? "승" : "패"}</span>}
      </span>
      {teamRoster(match, team).map((entry) => {
        const name = props.nameOf(entry.participantId);
        const position = entry.position ? POSITION_LABEL[entry.position] : null;
        return (
          <button
            key={entry.participantId}
            type="button"
            className={props.highlight.has(entry.participantId) ? "mc-name is-me" : "mc-name"}
            title={position && !props.withPositions ? `${position} ${name}` : name}
            onClick={() => props.onPerson(entry.participantId)}
          >
            <span className="mc-name-text">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * 요약 화면 맨 위의 전광판(2026-11-10 시안 "중계 화면"): 가장 최근 확정 경기 하나를 크게 보여 준다.
 * 경기 카드(MatchCard)와 같은 약속을 지킨다: 머리 줄이 경기 상세로 가는 버튼이고 빈 곳을 눌러도 같은 곳,
 * 이름은 개인 통계 버튼, 팀마다 "블루팀 승리" 같은 이름의 group.
 * - 왼쪽은 블루, 오른쪽은 레드. 진영을 모르면 팀 A가 왼쪽이고 줄 머리는 "●A"/"■B"(teamName 규칙).
 * - 포지션이 모두 있으면 가운데 라인 칸을 두고 라인끼리 마주 세운다. 없으면 라인 칸 없이 두 줄로만 나눈다.
 *   라인 칸은 두 팀 group 사이에 따로 두어(읽지 않음) 팀 group 안에는 그 팀 이름만 들어간다.
 * - 가운데 숫자는 시리즈 점수(seriesScoreOfMatch)이고, 시리즈가 아니면 숫자 없이 승패만 쓴다.
 */
export function MatchScoreboard(props: {
  match: MatchView;
  nameOf: (id: string) => string;
  timeZone: string;
  onOpen: () => void;
  onPerson: (id: string) => void;
  /** 이 경기의 시리즈 이름과 팀별 시리즈 승수. 없으면 가운데 숫자를 그리지 않는다. */
  series: { title: string; wins: Record<Team, number> } | null;
  upset?: boolean;
}) {
  const { match, series } = props;
  // 팀 A가 레드인 경기만 B를 왼쪽에 둔다(블루가 늘 왼쪽). 진영 미상은 A가 왼쪽.
  const [left, right]: [Team, Team] = knownSideOf("A", match.teamASide) === "red" ? ["B", "A"] : ["A", "B"];
  const withPositions = match.roster.length > 0 && match.roster.every((r) => r.position !== null);
  const when = `${formatDate(match.playedAt, props.timeZone)} ${formatTime(match.playedAt, props.timeZone)}`;
  const side = (team: Team, end: "left" | "right") => {
    const won = isCounted(match) ? match.winnerTeam === team : null;
    const known = knownSideOf(team, match.teamASide);
    return (
      <div className={`sb-side ${end} sb-${sideColorOf(team, match.teamASide)}`} aria-hidden="true">
        <span className="sb-side-name">
          {known ? (
            SIDE_LABEL[known]
          ) : (
            <>
              {TEAM_MARK[team]}
              {team}
            </>
          )}
        </span>
        {won !== null && <span className={won ? "sb-verdict win" : "sb-verdict"}>{won ? "승리" : "패배"}</span>}
      </div>
    );
  };
  const team = (t: Team, end: "left" | "right") => {
    const won = isCounted(match) ? match.winnerTeam === t : null;
    return (
      <div
        className={`sb-team ${end}${won === null ? "" : won ? " is-win" : " is-loss"}`}
        role="group"
        aria-label={`${teamName(t, match.teamASide)}${won === null ? "" : won ? " 승리" : " 패배"}`}
      >
        {teamRoster(match, t).map((entry) => {
          const name = props.nameOf(entry.participantId);
          return (
            <button
              key={entry.participantId}
              type="button"
              className="sb-name"
              title={entry.position && !withPositions ? `${POSITION_LABEL[entry.position]} ${name}` : name}
              onClick={() => props.onPerson(entry.participantId)}
            >
              <span className="sb-name-text">{name}</span>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <article className={`scoreboard tone-${matchTone(match)}`} aria-label={`최근 경기 ${match.matchNo}경기`}>
      <div className="sb-stripe" aria-hidden="true">
        <span className="sb-stripe-blue" />
        <span className="sb-stripe-red" />
      </div>
      <button type="button" className="sb-main" onClick={props.onOpen}>
        <span className="sb-kicker">
          최근 경기 · {match.matchNo}경기<span className="sr-only"> · {resultLine(match)}</span>
        </span>
        <span className="sb-when">
          {series && <>{series.title} · </>}
          {when}
        </span>
      </button>
      {(props.upset || match.memo) && (
        <p className="mc-extra sb-extra">
          {props.upset && (
            <span className="series-badge" title="경기 전 예상이 약팀이던 쪽이 이겼어요">
              이변
            </span>
          )}
          {match.memo && (
            <span className="mc-memo" title={match.memo}>
              <span className="mc-memo-label">메모</span>
              {memoOneLine(match.memo)}
            </span>
          )}
        </p>
      )}
      <div className="sb-score">
        {side(left, "left")}
        {series ? (
          <p className="sb-series">
            <span className="sr-only">시리즈 점수 </span>
            <span className={series.wins[left] < series.wins[right] ? "sb-series-num trail" : "sb-series-num"}>
              {series.wins[left]}
            </span>
            <span className="sb-series-colon" aria-hidden="true">
              :
            </span>
            <span className="sr-only"> 대 </span>
            <span className={series.wins[right] < series.wins[left] ? "sb-series-num trail" : "sb-series-num"}>
              {series.wins[right]}
            </span>
          </p>
        ) : (
          <span className="sb-vs" aria-hidden="true">
            vs
          </span>
        )}
        {side(right, "right")}
      </div>
      <div className={withPositions ? "sb-lanes with-pos" : "sb-lanes"}>
        {team(left, "left")}
        {withPositions && (
          <div className="sb-roles" aria-hidden="true">
            {POSITIONS.map((p) => (
              <span key={p} className="sb-role">
                <PosLabel position={p} />
              </span>
            ))}
          </div>
        )}
        {team(right, "right")}
      </div>
    </article>
  );
}

/** 경기 카드 목록. 비어 있으면 아무것도 그리지 않는다. */
export function MatchCardList(props: { children: ReactNode; label?: string }) {
  return (
    <ul className="list match-cards" aria-label={props.label}>
      {props.children}
    </ul>
  );
}

/**
 * 경기마다의 경기 전 예상(이변 지수, src/shared/upset.ts). 모임 전체 누적 MMR로 계산하므로 스냅숏이 바뀔 때만 다시 센다.
 * 경기 ID → 예상. 유효 확정 경기가 아니면 없다.
 */
export function useExpectations(snapshot: Snapshot | null): ReadonlyMap<string, MatchExpectation> {
  return useMemo(
    () => (snapshot ? matchExpectations(snapshot.matches, ratingOptionsOf(snapshot.group.settings)) : new Map()),
    [snapshot],
  );
}
