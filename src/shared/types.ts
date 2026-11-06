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
  /**
   * 기피 라인(라인 섞기에서 되도록 피할 포지션, 0~4개, 탑~서폿 순서). 운영자 응답·백업에만, 있을 때만 들어 있다.
   * 조회 링크 응답에는 공개 설정과 상관없이 넣지 않는다.
   */
  avoidPositions?: Position[];
  /**
   * 중복 참가자 합치기로 다른 사람에게 합쳐졌으면 그 사람의 ID(되돌리지 않은 합치기만).
   * 기기에 남은 초안·"내 이름"의 옛 ID를 새 ID로 바꾸는 데 쓴다. 합쳐진 사람은 항상 보관 상태다.
   */
  mergedInto?: string;
}

export interface Settings {
  /** 서포터 순환 사용 여부. */
  rotationEnabled: boolean;
  /** 실력 그룹을 조회자에게 공개하는지. 기본은 비공개다. */
  groupsPublic: boolean;
  /** 그룹 1~4의 가중치. 미확인·가정값이며 모임 설정이다. */
  groupWeights: [number, number, number, number];
  /**
   * 칭호 구간(docs/P2 P2-11). 공개 정보라 조회 응답에도 나간다.
   * 없음(undefined) = 한 번도 저장하지 않음 → 기본 구간을 쓴다.
   * 빈 배열 = 칭호를 쓰지 않기로 저장함 → 빈 채로 둔다(기본값으로 되돌아가지 않는다).
   */
  titleBands?: TitleBand[];
  /**
   * 팀 추천의 조합 다양성(src/shared/recommend.ts). 균형이 똑같은 후보 사이에서
   * 최근 같은 팀이었던 쌍이 적은 조합을 먼저 고른다.
   * 없음(undefined) = 한 번도 저장하지 않음 → 켜짐. false로 저장하면 꺼짐(예전 추천과 같은 결과).
   */
  teamDiversity?: boolean;
}

/** 칭호 한 구간. 누적 승률이 minRate% 이상이면 이 칭호다(위 구간부터 본다). */
export interface TitleBand {
  /** 0~100 정수. */
  minRate: number;
  name: string;
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

/** 서포터 횟수 직접 입력의 보정값(사람별). 표시 횟수 = 사건 수 + delta(0 미만이면 0). */
export interface SupportAdjustmentView {
  participantId: string;
  delta: number;
}

export interface RotationView {
  /** 활성 주기. null이면 아직 주기가 없고(첫 경기 전) 미리 넣은 보정값만 있다. */
  cycleId: string | null;
  /** 무효가 아닌 사건만. */
  events: RotationEventView[];
  /** 서포터 횟수 직접 입력의 보정값. 운영자 응답에만, 있을 때만 들어 있다(합쳐진 이름은 남은 사람에게 더해 둠). */
  adjustments?: SupportAdjustmentView[];
}

export interface RevisionView {
  id: number;
  /** 합치기 묶음 줄(kind "merge" / "merge_undo")은 빈 문자열이다(여러 경기에 걸친다). */
  matchId: string;
  matchNo: number;
  kind: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  createdAt: string;
  /**
   * 중복 참가자 합치기(또는 그 되돌리기)가 남긴 정정 이력을 한 줄로 묶은 것.
   * 원본 이력은 옮긴 경기마다 한 줄씩 그대로 남아 있다.
   */
  merge?: { sourceId: string; targetId: string; matchCount: number };
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
  /** 출처(migrations/0007, 0010). 붙여 넣기 / 구글 시트 / 기존 사이트. 출처를 남기기 전에 넣은 묶음에는 없다. */
  kind?: "paste" | "sheet" | "legacy";
  /** 구글 시트일 때 시트가 알려준 이름(문서 제목 - 탭 이름). */
  label?: string | null;
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
    /** 운영자 응답에만 있다. 백업 복원이 끝날 때마다 오른다. 화면은 쓰기 요청에 이 값을 실어 보낸다. */
    generation?: number;
    /**
     * 점검 중(백업 복원이 진행 중이거나 중간에 멈춤, 또는 모임 삭제가 진행 중)이면 true.
     * 운영자·조회 응답 모두에 있다(조회 화면이 "점검 중" 안내를 보여준다).
     */
    maintenance?: boolean;
  };
  participants: ParticipantView[];
  session: SessionView | null;
  rotation: RotationView | null;
  matches: MatchView[];
  revisions: RevisionView[];
  seasons: SeasonView[];
  /** 표 일괄 입력 기록. 운영자 응답에만 있다. */
  importBatches?: ImportBatchView[];
  /** 중복 참가자 합치기 기록(최근 것부터). 운영자 응답에만 있다. */
  merges?: MergeView[];
}

/** 중복 참가자 합치기 한 건. */
export interface MergeView {
  id: string;
  /** 합쳐진(없어진) 쪽. */
  sourceId: string;
  /** 남은 쪽. */
  targetId: string;
  /** 옮긴 경기 수. */
  matchCount: number;
  createdAt: string;
  /** 되돌렸으면 그 시각. */
  undoneAt: string | null;
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

/**
 * 결과 입력 창의 진영 기본값. 시작할 때 팀 A의 진영을 골라 두었으면(블루·레드) 고른 승리 팀의 진영을 미리 고른다.
 * 정하지 않았거나 미상이면 null(미리 고르지 않음). 사용자는 바꿀 수 있고 저장 때 확인한 값이 최종이다.
 */
export function presetWinnerSide(winnerTeam: Team, teamASide: Side | null): "blue" | "red" | null {
  const side = sideOfTeam(winnerTeam, teamASide);
  return side === "blue" || side === "red" ? side : null;
}
