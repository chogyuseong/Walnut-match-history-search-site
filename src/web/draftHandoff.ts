import type { Draft } from "../shared/draft";
import { parseNightPool } from "../shared/nightPool";
import { parseStoredDraft } from "../shared/storedDraft";
import type { DraftHandoffView, Snapshot } from "../shared/types";
import { ApiFailure, call } from "./api";
import { readNightPool, writeNightPool } from "./nightPoolStore";
import type { AppValue } from "./useApp";

// 편성 넘기기(서버 src/server/draftHandoff.ts, migrations/0029). 준비 화면(screens/Prep.tsx)이 지금 편성과 오늘 명단을
// 서버 한 칸에 맡기고, 다른 기기의 오늘 화면(screens/Today.tsx)이 운영자 스냅숏의 요약(draftHandoff)을 보고 이어받는다.
// 같은 계정의 PC → 휴대폰도, 공동 운영자에게 맡기는 것도 같은 길이다(서버는 누가 넘겼는지 화면에 주지 않는다).
//
// 넘긴 기기는 자기가 넘긴 것을 handoffId로 알아본다(sentKey). 그 기기에는 이어받기 대신 "넘겨 두었어요 · 취소"를 보인다.
// 첫 화면 묶음(useApp.ts)에 넣지 않는다: 오늘·준비 화면 조각만 이 파일을 부른다(check:bundle 첫 화면 예산).

/**
 * 넘긴 지 이만큼 지난 것은 보여 주지 않는다(12시간, 오늘 명단이 세션에 묶이기 전 수명과 같다). 지난주에 넘기고 잊은 편성이
 * 다음 모임 날 "이어받기"로 뜨지 않게 하려는 것이다. 서버는 시간으로 지우지 않고, 다음 넘기기·경기 시작이 지운다.
 */
export const HANDOFF_FRESH_MS = 12 * 3600_000;

/** 이어받았지만 기기에 저장하지 못해 서버 사본을 남겨 둔 때의 안내. 준비 화면(Prep.tsx)의 저장 실패 경고 줄이 쓴다. */
export const HANDOFF_KEPT_ON_SERVER =
  "이 기기에 저장하지 못해서 넘긴 편성을 서버에 그대로 두었어요. 창을 닫았다가 다시 열면 오늘 화면에서 다시 이어받을 수 있어요(넘긴 지 12시간까지).";

const sentKey = (groupId: string) => `naejeon.handoffSent.v1.${groupId}`;

function sentId(groupId: string): string | null {
  try {
    return localStorage.getItem(sentKey(groupId));
  } catch {
    return null;
  }
}

function rememberSent(groupId: string, handoffId: string | null): void {
  try {
    if (handoffId === null) localStorage.removeItem(sentKey(groupId));
    else localStorage.setItem(sentKey(groupId), handoffId);
  } catch {
    // 기억하지 못하면 이 기기에도 "이어받기"가 뜰 뿐이다(이어받아도 같은 편성).
  }
}

export interface HandoffState {
  view: DraftHandoffView;
  /** 이 기기가 넘긴 것. */
  mine: boolean;
  /** 넘긴 뒤 경기 상태(진행 상태 버전)가 바뀌었다. 이어받은 편성은 준비 화면이 "다른 기기에서 경기 상태가 바뀌었어요"로 알린다. */
  stale: boolean;
}

/** 지금 보여 줄 넘긴 편성. 없거나 오래됐으면 null. */
export function handoffOf(snapshot: Snapshot | null, nowMs = Date.now()): HandoffState | null {
  const view = snapshot?.draftHandoff;
  if (!snapshot || !view) return null;
  if (nowMs - Date.parse(view.createdAt) > HANDOFF_FRESH_MS) return null;
  return {
    view,
    mine: sentId(snapshot.group.id) === view.id,
    stale: view.baseLiveVersion !== null && view.baseLiveVersion !== snapshot.group.liveVersion,
  };
}

/** 지금 편성(과 오늘 명단)을 넘긴다. 같은 모임에 넘긴 것이 있으면 서버가 덮어쓴다. */
export async function sendHandoff(app: AppValue, draft: Draft): Promise<void> {
  const groupId = draft.groupId ?? app.groupId;
  if (!groupId) return;
  const handoffId = crypto.randomUUID();
  await call("PUT", `/api/groups/${groupId}/draft-handoff`, {
    handoffId,
    draft: { ...draft, groupId },
    nightPool: readNightPool(groupId),
  });
  rememberSent(groupId, handoffId);
  await app.refresh();
}

/** 넘긴 것을 지운다(넘긴 기기의 "넘기기 취소", 받는 기기의 "버리기"). 그 사이 새로 넘긴 것은 지우지 않는다. */
export async function dropHandoff(app: AppValue, view: DraftHandoffView): Promise<void> {
  const groupId = app.snapshot?.group.id;
  if (!groupId) return;
  await call("DELETE", `/api/groups/${groupId}/draft-handoff?id=${encodeURIComponent(view.id)}`);
  if (sentId(groupId) === view.id) rememberSent(groupId, null);
  await app.refresh();
}

/**
 * 넘긴 편성을 이 기기의 작성 중인 편성으로 가져온다. 기기에 저장한 다음 서버에서 지운다(지우기가 실패해도 편성은 남는다).
 * - expectedId는 사용자가 본 안내의 넘기기 ID다. 안내를 본 뒤 다른 기기가 다시 넘겼으면 받은 본문이 다르므로
 *   편성을 바꾸지 않고, 안내를 새로 읽은 뒤 오류를 던진다(본 적 없는 판으로 바뀌지 않게).
 * - 기기 저장(초안·오늘 명단)이 하나라도 실패하면 서버 사본을 지우지 않는다. 화면에는 편성이 올라가지만
 *   탭을 닫으면 사라지므로, 다시 열었을 때 이어받을 사본을 남긴다. 남은 사본은 다음 넘기기·경기 시작·24시간 정리가 지운다.
 *   돌려주는 kept가 false면 부른 쪽이 그 사실을 알린다.
 * 진행 상태 버전(baseLiveVersion)은 넘긴 때의 값 그대로 둔다: 그 사이 경기가 시작됐으면 준비 화면이 알리고,
 * 그대로 시작을 누르면 서버가 409로 막는다(matches.ts startMatch).
 * 받은 본문이 기기 저장값 검사를 통과하지 못하면(다른 판의 화면이 넘긴 것 등) 오류를 던진다.
 */
export async function takeHandoff(app: AppValue, expectedId: string): Promise<{ kept: boolean }> {
  const snapshot = app.snapshot;
  if (!snapshot) return { kept: true };
  const groupId = snapshot.group.id;
  const body = await call<{ handoffId: string; draft: unknown; nightPool: unknown }>(
    "GET",
    `/api/groups/${groupId}/draft-handoff`,
  );
  if (body.handoffId !== expectedId) {
    await app.refresh();
    throw new ApiFailure(
      "api",
      "그 사이 다른 기기에서 편성을 다시 넘겼어요. 안내를 새로 불러왔으니 시각과 인원을 확인하고 다시 이어받아 주세요.",
    );
  }
  const parsed = parseStoredDraft(JSON.stringify(body.draft));
  if (!parsed || parsed.groupId !== groupId) {
    throw new ApiFailure("api", "넘겨받은 편성을 읽지 못했어요. 넘긴 기기에서 화면을 새로 고친 뒤 다시 넘겨 주세요.");
  }
  // 합쳐진 참가자 이름은 아래 app.refresh()가 맞춘다(useApp.ts loadSnapshot이 작성 중인 편성에 remapDraft를 건다).
  const draftKept = app.setDraft(parsed);
  const pool = parseNightPool(JSON.stringify(body.nightPool), groupId);
  const poolKept = pool ? writeNightPool(pool) : true;
  rememberSent(groupId, null);
  const kept = draftKept && poolKept;
  if (kept) {
    try {
      await call("DELETE", `/api/groups/${groupId}/draft-handoff?id=${encodeURIComponent(body.handoffId)}`);
    } catch {
      // 서버에 남아도 다음 넘기기·경기 시작이 지운다. 이어받은 편성은 이미 이 기기에 있다.
    }
  }
  await app.refresh();
  return { kept };
}
