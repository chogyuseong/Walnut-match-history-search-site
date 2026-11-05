/** 서버와 브라우저가 함께 쓰는 자료 형태. */

export type Team = "A" | "B";
export const TEAMS: readonly Team[] = ["A", "B"];

export type Position = "top" | "jungle" | "mid" | "adc" | "support";
export const POSITIONS: readonly Position[] = ["top", "jungle", "mid", "adc", "support"];

/** 실제 진영. "unknown"은 기억나지 않음이다. */
export type Side = "blue" | "red" | "unknown";
export const SIDES: readonly Side[] = ["blue", "red", "unknown"];

export type MatchState = "in_progress" | "awaiting_result" | "confirmed" | "canceled" | "excluded";
export type MatchSource = "live" | "backfill" | "import";

export interface RosterEntry {
  participantId: string;
  team: Team;
  /** 지난 경기 입력·이관 경기는 포지션이 없을 수 있다. */
  position: Position | null;
}

export interface MatchView {
  id: string;
  matchNo: number;
  sessionId: string | null;
  state: MatchState;
  source: MatchSource;
  startedAt: string | null;
  endedAt: string | null;
  playedAt: string;
  confirmedAt: string | null;
  winnerTeam: Team | null;
  /** 팀 A의 진영. 팀 B는 항상 그 반대다. */
  teamASide: Side | null;
  version: number;
  roster: RosterEntry[];
}

export interface ParticipantView {
  id: string;
  name: string;
  status: "active" | "archived";
  /** 1~4 또는 null(미지정). 비공개 모임의 조회 응답에는 이 필드가 없다. */
  skillGroup?: number | null;
}

export interface Settings {
  /** 서포터 순환 사용 여부. */
  rotationEnabled: boolean;
  /** 실력 그룹을 조회자에게 공개하는지. 기본은 비공개다. */
  groupsPublic: boolean;
  /** 그룹 1~4의 가중치. 미확인·가정값이며 모임 설정이다. */
  groupWeights: [number, number, number, number];
}

export const DEFAULT_SETTINGS: Settings = {
  rotationEnabled: true,
  groupsPublic: false,
  groupWeights: [4, 3, 2, 1],
};

export interface RotationEventView {
  matchId: string;
  participantId: string;
  kind: "used" | "repeat";
}

export interface RotationView {
  cycleId: string;
  /** 무효가 아닌 사건만. */
  events: RotationEventView[];
}

export interface RevisionView {
  id: number;
  matchId: string;
  matchNo: number;
  kind: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  createdAt: string;
}

export interface SessionView {
  id: string;
  startedAt: string;
  lastActivityAt: string;
}

export interface SeasonView {
  id: string;
  name: string;
  /** 모임 표시 시간대 기준 YYYY-MM-DD. 양 끝을 포함한다. */
  startsOn: string;
  endsOn: string;
}

export interface ImportBatchView {
  id: string;
  /** 이 묶음으로 넣은 경기 수. */
  count: number;
  /** 그중 지금 전적 제외 상태인 경기 수. */
  excluded: number;
  importedAt: string;
}

export interface Snapshot {
  role: "operator" | "viewer";
  serverTime: string;
  group: {
    id: string;
    name: string;
    timezone: string;
    liveVersion: number;
    settings: Settings;
    /** 운영자 응답에만 있다. */
    settingsVersionId?: string;
    viewToken?: string;
  };
  participants: ParticipantView[];
  session: SessionView | null;
  rotation: RotationView | null;
  matches: MatchView[];
  revisions: RevisionView[];
  seasons: SeasonView[];
  /** 표 일괄 입력 기록. 운영자 응답에만 있다. */
  importBatches?: ImportBatchView[];
}

/** 승리 팀의 진영에서 팀 A의 진영을 구한다. */
export function teamASideFromWinner(winnerTeam: Team, winnerSide: Side): Side {
  if (winnerSide === "unknown") return "unknown";
  if (winnerTeam === "A") return winnerSide;
  return winnerSide === "blue" ? "red" : "blue";
}

/** 주어진 팀의 진영을 구한다. */
export function sideOfTeam(team: Team, teamASide: Side | null): Side | null {
  if (teamASide === null) return null;
  if (teamASide === "unknown") return "unknown";
  if (team === "A") return teamASide;
  return teamASide === "blue" ? "red" : "blue";
}
