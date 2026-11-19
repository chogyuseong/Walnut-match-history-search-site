import { TEAMS, type Side, type Team } from "../shared/types";

// 결과 입력 창(screens/ResultSheet.tsx)에서 저장 전에 고른 내용을 이 기기에 잠시 남긴다.
// 열 명의 챔피언과 메모를 넣다가 창을 잘못 닫거나 새로 고쳐도 다시 열면 이어 쓸 수 있게 하려는 것이다.
// 모임·경기마다 따로 두고, 저장에 성공하면 지운다. 서버에는 보내지 않는다.
//
// 흐름(ResultSheet.tsx): 창을 열 때 load → 남은 것이 있으면 "이어 쓰기/버리고 새로 입력"을 보여 줌 →
// 무엇이든 고르거나 입력하면 그때부터 save(입력할 때마다 덮어씀) → 결과 저장 성공 때 clear.
// 정정(이미 확정된 경기의 승리 팀 수정)에는 쓰지 않는다. 고를 것이 승리 팀 하나뿐이라 잃을 수고가 없다.
//
// 편성 초안(useApp.ts DRAFT_KEY)과는 따로다. 편성은 모임에 하나, 결과 입력은 경기마다 하나라 열쇠 규칙이 다르다.

/**
 * 저장 열쇠 앞부분. 뒤에 "모임ID:경기ID"가 붙는다.
 * ResultDraft 모양을 바꾸면(칸 이름 변경 등) v1 → v2로 올린다. 옛 모양을 읽어 엉뚱하게 되살리지 않게 하려는 것이다
 * (옛 열쇠의 값은 DRAFT_TTL_MS가 지나도 열지 않으면 남지만, 경기 하나에 수백 바이트라 그대로 둔다).
 * E2E(e2e/browse-memory.spec.ts)가 이 앞부분으로 "저장 뒤 지워졌는지"를 확인하므로 바꾸면 그쪽도 고친다.
 */
const KEY_PREFIX = "naejeon.result-draft.v1:";
/** 이보다 오래된 임시 내용은 읽지 않고 지운다. 며칠 지난 경기의 입력을 엉뚱하게 되살리지 않게 한다. */
const DRAFT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export interface ResultDraft {
  /** 적을 때의 경기 버전. 지금 경기 버전과 다르면 그 사이 다른 기기·운영자가 경기를 고친 것이다. */
  matchVersion: number;
  winner: Team | null;
  side: Side | null;
  memo: string;
  /** 참가자 ID → 챔피언 ID. */
  champions: Record<string, string>;
  savedAt: number;
}

function keyOf(groupId: string, matchId: string): string {
  return `${KEY_PREFIX}${groupId}:${matchId}`;
}

const SIDES: readonly Side[] = ["blue", "red", "unknown"];

/** 버전을 읽을 수 없는 초안에 붙이는 값. 어떤 경기 버전과도 같지 않아 "다시 확인해 주세요" 안내가 뜬다. */
const UNKNOWN_VERSION = -1;

export interface LoadedResultDraft {
  draft: ResultDraft;
  /** 남아 있던 승리 팀(또는 진영) 값을 믿을 수 없어 비웠다. 운영자가 이긴 팀을 다시 골라야 한다. */
  winnerReset: boolean;
}

/**
 * 저장소에서 꺼낸 글을 초안으로 되살린다. 쓸 수 없으면 null(만료 포함).
 * 다른 판의 코드가 남긴 값, 손으로 고친 값, 일부만 쓰다 끊긴 값이 올 수 있어 칸마다 따로 거른다.
 * 메모와 챔피언처럼 틀려도 저장 전에 눈으로 확인할 수 있는 것은 살리고, 이긴 팀처럼 10명의 승패를 정하는 값은
 * 허용값이 아니면 비운다(진영은 이긴 팀 기준 값이라 함께 비운다). 화면 코드 없이 테스트하려고 저장소와 떼어 뒀다.
 */
export function parseResultDraft(text: string, now: number): LoadedResultDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.savedAt !== "number" || !Number.isFinite(raw.savedAt) || now - raw.savedAt > DRAFT_TTL_MS) {
    return null;
  }

  const winnerOk = raw.winner === null || raw.winner === undefined || TEAMS.includes(raw.winner as Team);
  const sideOk = raw.side === null || raw.side === undefined || SIDES.includes(raw.side as Side);
  const winnerReset = !winnerOk || !sideOk;
  const winner = winnerReset ? null : ((raw.winner as Team | undefined) ?? null);
  const side = winnerReset || winner === null ? null : ((raw.side as Side | undefined) ?? null);

  const champions: Record<string, string> = {};
  if (typeof raw.champions === "object" && raw.champions !== null && !Array.isArray(raw.champions)) {
    for (const [participantId, championId] of Object.entries(raw.champions)) {
      if (typeof championId === "string" && championId !== "") champions[participantId] = championId;
    }
  }

  return {
    draft: {
      matchVersion: typeof raw.matchVersion === "number" ? raw.matchVersion : UNKNOWN_VERSION,
      winner,
      side,
      memo: typeof raw.memo === "string" ? raw.memo : "",
      champions,
      savedAt: raw.savedAt,
    },
    winnerReset,
  };
}

export function loadResultDraft(groupId: string, matchId: string): LoadedResultDraft | null {
  try {
    const raw = localStorage.getItem(keyOf(groupId, matchId));
    if (!raw) return null;
    const loaded = parseResultDraft(raw, Date.now());
    // 만료됐거나 아예 읽을 수 없는 것은 이 경기 열쇠만 지운다. 다른 경기·모임의 초안은 건드리지 않는다.
    if (!loaded) localStorage.removeItem(keyOf(groupId, matchId));
    return loaded;
  } catch {
    // 저장소를 못 쓰면 이어 쓰기 없이 새로 입력한다.
    return null;
  }
}

/**
 * 남기지 못했으면 false. 저장소가 가득 찼거나 막힌 브라우저(사생활 보호 모드 등)다.
 * 입력은 창 안에 그대로 있으니 계속 쓸 수 있고, 창을 닫으면 사라진다는 것만 화면에서 알린다.
 */
export function saveResultDraft(groupId: string, matchId: string, draft: ResultDraft): boolean {
  try {
    localStorage.setItem(keyOf(groupId, matchId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearResultDraft(groupId: string, matchId: string): void {
  try {
    localStorage.removeItem(keyOf(groupId, matchId));
  } catch {
    // 지우지 못해도 다음에 열 때 경기 상태가 바뀌어 있어 이어 쓰기를 보여 주지 않는다.
  }
}
