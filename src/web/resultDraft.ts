import type { Side, Team } from "../shared/types";

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

export function loadResultDraft(groupId: string, matchId: string): ResultDraft | null {
  try {
    const raw = localStorage.getItem(keyOf(groupId, matchId));
    if (!raw) return null;
    const draft = JSON.parse(raw) as ResultDraft;
    if (typeof draft.savedAt !== "number" || Date.now() - draft.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(keyOf(groupId, matchId));
      return null;
    }
    return draft;
  } catch {
    // 저장소를 못 쓰거나 내용이 깨졌으면 이어 쓰기 없이 새로 입력한다.
    return null;
  }
}

export function saveResultDraft(groupId: string, matchId: string, draft: ResultDraft): void {
  try {
    localStorage.setItem(keyOf(groupId, matchId), JSON.stringify(draft));
  } catch {
    // 저장소가 가득 찼거나 막혀 있어도 입력은 계속한다(창을 닫으면 사라질 뿐이다).
  }
}

export function clearResultDraft(groupId: string, matchId: string): void {
  try {
    localStorage.removeItem(keyOf(groupId, matchId));
  } catch {
    // 지우지 못해도 다음에 열 때 경기 상태가 바뀌어 있어 이어 쓰기를 보여 주지 않는다.
  }
}
