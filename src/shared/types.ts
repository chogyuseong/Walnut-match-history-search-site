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
  /**
   * 그 경기에서 쓴 챔피언의 고정 키(src/shared/champions.ts, migrations/0025). 고른 사람만 들어 있는 선택 항목이다.
   * 메모처럼 공개 정보다: 조회 링크 응답·백업에도 들어간다.
   */
  champion?: string;
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
  /**
   * 경기 메모(최대 200자, 줄바꿈 허용, migrations/0016). 있을 때만 들어 있다.
   * 공개 정보다: 조회 링크 응답·백업에도 들어간다. 화면은 글자로만 그린다(HTML로 해석하지 않는다).
   */
  memo?: string;
  /**
   * 지운 시각(migrations/0026). 화면이 받는 스냅숏·조회 응답에는 지운 경기가 아예 없으므로 이 값도 없다.
   * 백업 파일과 삭제 요청의 응답처럼 지운 경기까지 일부러 읽은 곳에만 들어 있다.
   */
  deletedAt?: string;
}

/** 시리즈 형식. bo3: 3판 2선승, bo5: 5판 3선승, free: 자유. */
export type SeriesFormat = "bo3" | "bo5" | "free";
export const SERIES_FORMATS: readonly SeriesFormat[] = ["bo3", "bo5", "free"];

/** 시리즈 묶음(migrations/0017). 조회 링크 응답·백업에도 들어간다. */
export interface SeriesView {
  id: string;
  /** 선택(예: "결승"). 없으면 null. */
  name: string | null;
  format: SeriesFormat;
  createdAt: string;
  /** 속한 경기 ID. 경기 시각 → 경기 번호 순. */
  matchIds: string[];
}

export interface ParticipantView {
  id: string;
  name: string;
  status: "active" | "archived";
  /** 1~5 또는 null(미지정). 비공개 모임의 조회 응답에는 이 필드가 없다. */
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
  /**
   * 참가자 행 버전(migrations/0021). 운영자 스냅숏에만 있다(조회 응답·백업에는 없음).
   * 참가자 수정(PATCH /api/groups/:gid/participants/:pid)에 baseVersion으로 보내면 그 사이 다른 수정이 있었을 때
   * 409 VERSION_CONFLICT로 거절된다.
   */
  version?: number;
}

export interface Settings {
  /** 서포터 순환 사용 여부. */
  rotationEnabled: boolean;
  /** 실력 그룹을 조회자에게 공개하는지. 기본은 비공개다. */
  groupsPublic: boolean;
  /**
   * 티어 1~5의 가중치. 미확인·가정값이며 모임 설정이다.
   * 4단계 시절(2026-11-06 전)에 저장한 4개짜리 값은 읽을 때 upgradeGroupWeights로 5개로 맞춘다.
   */
  groupWeights: GroupWeights;
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
  /**
   * 배치 경기 수(1~30 정수, stats.ts PLACEMENT_GAMES_MIN/MAX). 공개 정보라 조회 응답에도 나간다.
   * 없음(undefined) = 한 번도 저장하지 않음 → 기본 10(placementGamesOf). 바꾸면 지난 경기까지 다시 계산된다.
   */
  placementGames?: number;
  /**
   * MMR 시작 점수(600~3000)·배치 중 K·배치 뒤 K(각 1~100), 모두 정수. 범위는 rating.ts RATING_SETTING_RANGES.
   * 없음 = 저장하지 않음 → 기본 1200 · 50 · 30(ratingOptionsOf). 공개 정보라 조회 응답에도 나간다.
   */
  ratingStart?: number;
  ratingKPlacement?: number;
  ratingK?: number;
}

/** 칭호 한 구간. 누적 승률이 minRate% 이상이면 이 칭호다(위 구간부터 본다). */
export interface TitleBand {
  /** 0~100 정수. */
  minRate: number;
  name: string;
}

/** 가장 낮은 티어 번호(티어는 1~이 값). 2026-11-06에 4에서 5로 늘었다(migrations/0020). */
export const MAX_SKILL_GROUP = 5;

/** 티어 1~5의 가중치(1티어가 첫 값). */
export type GroupWeights = [number, number, number, number, number];

export const DEFAULT_SETTINGS: Settings = {
  rotationEnabled: true,
  groupsPublic: false,
  groupWeights: [5, 4, 3, 2, 1],
};

/** 4단계 시절의 기본 가중치. 이 값 그대로였던 모임은 새 기본값 [5,4,3,2,1]을 받는다. */
const OLD_DEFAULT_WEIGHTS = [4, 3, 2, 1] as const;

/**
 * 저장된 가중치를 5개로 맞춘다. 5개면 그대로(복사본), 4개면(티어 4단계 시절 저장분):
 * - 예전 기본값 [4,3,2,1] 그대로면 새 기본값 [5,4,3,2,1].
 * - 직접 바꾼 값이면 네 값은 그대로 두고 다섯째를 "넷째 − (셋째 − 넷째)"로 채운다(같은 간격으로 한 칸 더). 0 미만이면 0, 1000 초과면 1000.
 * 그 밖의 길이는 호출하는 쪽이 먼저 거른다(parseSettings).
 */
export function upgradeGroupWeights(weights: readonly number[]): GroupWeights {
  if (weights.length === 4) {
    if (weights.every((w, i) => w === OLD_DEFAULT_WEIGHTS[i])) return [...DEFAULT_SETTINGS.groupWeights];
    const [a, b, c, d] = weights as [number, number, number, number];
    // 소수 가중치의 부동소수 오차(0.3 − 0.2 = 0.09999…)는 셋째 자리에서 반올림해 없앤다.
    const fifth = Math.min(1000, Math.max(0, Math.round((d - (c - d)) * 1000) / 1000));
    return [a, b, c, d, fifth];
  }
  return [...weights] as GroupWeights;
}

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
  /**
   * 활성 주기가 열린 시각(ISO). 새 내전 시작 또는 "서포터 횟수 초기화" 시각이다. 이 뒤에 시작한 경기만 횟수에 든다.
   * 화면이 "언제부터 세는지"를 보여 주는 데 쓴다(2026-11-08). 주기가 없으면 없다.
   */
  cycleStartedAt?: string;
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
  /**
   * 경기 삭제 줄(changes.deleted, src/server/matches.ts deleteMatch) 가운데 그 경기가 지금도 지워져 있고 가장 최근의
   * 삭제 줄에만 있다. 지운 경기는 스냅숏의 matches에 없으므로 되살리기 요청의 baseMatchVersion을 여기서 얻는다.
   */
  deletedMatch?: { version: number };
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
  /** 시리즈 묶음(migrations/0017). 운영자·조회 응답 모두에 있다. 예전 서버 응답에는 없을 수 있다. */
  series?: SeriesView[];
  /** 표 일괄 입력 기록. 운영자 응답에만 있다. */
  importBatches?: ImportBatchView[];
  /** 중복 참가자 합치기 기록(최근 것부터). 운영자 응답에만 있다. */
  merges?: MergeView[];
  /** 참가자 본인 연결(migrations/0019). 운영자 응답에만 있다. 계정 정보는 담지 않는다(연결 여부·시각만). */
  memberLinks?: MemberLinkView[];
  /** 아직 쓰지 않은 연결 링크(만료 전). 운영자 응답에만 있다. 토큰은 담지 않는다. */
  memberClaims?: MemberClaimView[];
  /** 참가자 요청(열린 것 전부 + 최근 처리한 것). 운영자 응답에만 있다. */
  memberRequests?: MemberRequestView[];
  /**
   * 멤버(연결한 참가자) 응답에만 있다. 나머지는 조회 링크 응답과 같다(같은 직렬화 함수).
   * 내 것만 담는다: 내 참가자 ID, 내 기피 라인, 내 요청.
   */
  me?: MemberSelfView;
}

/** 참가자 ↔ 계정 연결 한 건(운영자용). */
export interface MemberLinkView {
  participantId: string;
  linkedAt: string;
  /** 지금 기피 라인을 본인이 정했는지(그 뒤 운영자가 고치면 false). */
  avoidBySelf: boolean;
}

export interface MemberClaimView {
  participantId: string;
  expiresAt: string;
}

export type MemberRequestKind = "correction" | "erase";
export type MemberRequestStatus = "open" | "done" | "declined";

export interface MemberRequestView {
  id: string;
  participantId: string;
  kind: MemberRequestKind;
  /** 정정 요청의 대상 경기. 삭제·익명 요청은 null. */
  matchId: string | null;
  text: string;
  status: MemberRequestStatus;
  reply: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface MemberSelfView {
  participantId: string;
  avoidPositions: Position[];
  /** 지금 기피 라인을 본인이 정했는지. */
  avoidBySelf: boolean;
  requests: MemberRequestView[];
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
