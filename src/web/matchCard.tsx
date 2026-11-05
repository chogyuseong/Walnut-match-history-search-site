import type { ReactNode } from "react";
import { isCounted } from "../shared/stats";
import { POSITIONS, sideOfTeam, TEAMS, type MatchView, type Team } from "../shared/types";
import {
  formatDate,
  formatTime,
  matchTone,
  POSITION_LABEL,
  resultLine,
  SIDE_LABEL,
  TEAM_MARK,
  teamRoster,
} from "./format";
import { PosLabel } from "./ui";

/**
 * 경기 카드. 기록 목록·홈·개인 통계·비교가 함께 쓴다.
 * - 맨 위 줄(경기 번호·결과·시각)이 경기 상세로 가는 버튼이고, 카드의 빈 곳을 눌러도 같은 곳으로 간다.
 * - 이름은 따로 누를 수 있는 버튼이며 그 사람의 개인 통계로 간다.
 * - 두 팀은 한 줄씩(위: 팀 A, 아래: 팀 B). 포지션이 모두 있으면 라인 순서로 칸을 맞추고 위에 라인 이름을 둔다.
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
  const side = sideOfTeam(team, match.teamASide);
  const sideText = side === "blue" || side === "red" ? ` ${SIDE_LABEL[side]}` : "";
  const label = `팀 ${team}${sideText}${won === null ? "" : won ? " 승리" : " 패배"}`;
  return (
    <div
      className={won === null ? "mc-team" : won ? "mc-team is-win" : "mc-team is-loss"}
      role="group"
      aria-label={label}
    >
      <span className="mc-team-label" aria-hidden="true">
        <span>
          {TEAM_MARK[team]}
          {team}
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

/** 경기 카드 목록. 비어 있으면 아무것도 그리지 않는다. */
export function MatchCardList(props: { children: ReactNode; label?: string }) {
  return (
    <ul className="list match-cards" aria-label={props.label}>
      {props.children}
    </ul>
  );
}
