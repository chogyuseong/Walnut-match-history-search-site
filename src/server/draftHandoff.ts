/**
 * 편성 넘기기(migrations/0029). 준비 화면의 "다른 기기로 넘기기"가 초안을 맡기고(PUT), 다른 기기의 오늘·준비 화면이
 * 운영자 스냅숏의 요약(draftHandoff)을 보고 이어받는다(GET으로 본문을 받은 뒤 DELETE). 화면 쪽은 src/web/draftHandoff.ts.
 *
 * 서버는 편성을 해석하지 않는다. 겉모양(10명·10자리)과 크기만 보고 그대로 둔다. 시작 요청은 지금처럼 명단 전체를 받아
 * 처음부터 검증하므로(matches.ts), 여기서 받은 초안이 틀려도 기록이 틀어지지 않는다. 받는 기기가 기기 저장값과 같은
 * 검사(parseStoredDraft)로 다시 거른다.
 *
 * 이어받기를 "읽고 지우기" 한 요청으로 만들지 않은 까닭: 응답이 오다 끊기면 편성이 서버에서도 기기에서도 사라진다.
 * 받는 기기가 본문을 기기에 저장한 다음에 지운다.
 */
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, nowIso, readJsonBody } from "./http";

/**
 * 본문 상한(바이트). 초안은 되돌리기 이력 5단계까지 넣어도 6KB 안팎이고, 오늘 명단(20~30명)을 더해도 10KB를 넘기 어렵다.
 * 일반 쓰기 상한(16KB)보다 조금 넉넉히 둔다.
 */
const MAX_HANDOFF_BYTES = 32 * 1024;
/** 편성 인원. 시작 요청과 같은 10명. 대기자는 따로 센다. */
const LINEUP_SIZE = 10;
/** 넘긴 기기가 만드는 ID의 꼴(crypto.randomUUID 등). */
const HANDOFF_ID = /^[\w-]{8,64}$/;

/** PUT /api/groups/:gid/draft-handoff. 이 모임의 넘긴 편성을 새로 둔다(있으면 덮어쓴다). */
export async function putDraftHandoff(env: Env, groupId: string, req: Request): Promise<{ createdAt: string }> {
  const payload = await readJsonBody(req, MAX_HANDOFF_BYTES);
  // requestId는 다른 운영자 쓰기와 같은 꼴로 보내도 되게 받기만 한다. 같은 handoffId로 다시 보내면 같은 결과라 중복 확인은 하지 않는다.
  assertOnlyKeys(payload, ["requestId", "handoffId", "draft", "nightPool"]);
  const { handoffId, draft, nightPool } = payload;
  if (typeof handoffId !== "string" || !HANDOFF_ID.test(handoffId)) {
    throw new ApiError(400, "INVALID_FIELD", "넘기기 ID가 올바르지 않습니다.");
  }
  if (!isLineup(draft)) throw new ApiError(400, "INVALID_FIELD", "넘길 편성이 올바르지 않습니다.");
  if (nightPool !== undefined && nightPool !== null && (typeof nightPool !== "object" || Array.isArray(nightPool))) {
    throw new ApiError(400, "INVALID_FIELD", "오늘 명단이 올바르지 않습니다.");
  }
  const bench = Array.isArray(draft.bench) ? draft.bench.length : 0;
  const baseLiveVersion = Number.isInteger(draft.baseLiveVersion) ? (draft.baseLiveVersion as number) : null;
  const createdAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO draft_handoffs (group_id, handoff_id, body, base_live_version, people, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (group_id) DO UPDATE SET handoff_id = excluded.handoff_id, body = excluded.body,
       base_live_version = excluded.base_live_version, people = excluded.people, created_at = excluded.created_at`,
  )
    .bind(groupId, handoffId, JSON.stringify({ draft, nightPool: nightPool ?? null }), baseLiveVersion, LINEUP_SIZE + bench, createdAt)
    .run();
  return { createdAt };
}

/** GET /api/groups/:gid/draft-handoff. 본문을 돌려준다. 없으면(이미 누가 이어받았거나 경기를 시작함) 404. */
export async function readDraftHandoff(
  env: Env,
  groupId: string,
): Promise<{ handoffId: string; createdAt: string; draft: unknown; nightPool: unknown }> {
  const row = await env.DB.prepare("SELECT handoff_id, body, created_at FROM draft_handoffs WHERE group_id = ?1")
    .bind(groupId)
    .first<{ handoff_id: string; body: string; created_at: string }>();
  if (!row) throw new ApiError(404, "HANDOFF_GONE", "넘긴 편성이 없어요. 이미 다른 기기에서 이어받았거나 경기를 시작했어요.");
  const body = JSON.parse(row.body) as { draft: unknown; nightPool: unknown };
  return { handoffId: row.handoff_id, createdAt: row.created_at, draft: body.draft, nightPool: body.nightPool };
}

/**
 * DELETE /api/groups/:gid/draft-handoff?id=… 이어받은 뒤·넘기기 취소·버리기. id를 주면 그 넘기기일 때만 지운다:
 * 이어받는 사이 다른 기기가 새로 넘겼으면 새것을 지우지 않는다. 이미 없어도 성공으로 본다.
 */
export async function clearDraftHandoff(env: Env, groupId: string, handoffId: string | undefined): Promise<void> {
  if (handoffId === undefined) {
    await env.DB.prepare("DELETE FROM draft_handoffs WHERE group_id = ?1").bind(groupId).run();
    return;
  }
  await env.DB.prepare("DELETE FROM draft_handoffs WHERE group_id = ?1 AND handoff_id = ?2").bind(groupId, handoffId).run();
}

/**
 * 이어받지 않고 남은 넘긴 편성을 지우는 기준(24시간). 화면은 12시간 지난 것을 보여 주지 않는다(web/draftHandoff.ts
 * HANDOFF_FRESH_MS). 참가자 이름이 들어 있어 기간 없이 두지 않는다. 지우는 일은 새벽 예정 작업이 한다(pruneDraftHandoffs).
 * 개인정보 처리방침(screens/Privacy.tsx)의 보관 기간과 같게 둔다.
 */
export const HANDOFF_KEEP_MS = 24 * 3600_000;

/** 예정 작업(index.ts scheduled)이 부른다. 넘긴 지 HANDOFF_KEEP_MS가 지난 것을 지운다. 지운 수를 돌려준다. */
export async function pruneDraftHandoffs(env: Env, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - HANDOFF_KEEP_MS).toISOString();
  const result = await env.DB.prepare("DELETE FROM draft_handoffs WHERE created_at < ?1").bind(cutoff).run();
  return result.meta.changes ?? 0;
}

/** 경기 시작 batch에 넣는 문장. 시작한 뒤의 넘긴 편성은 지난 상태라 지운다. 행이 없으면 쓰기 0행이다. */
export function clearHandoffOnStart(env: Env, groupId: string): D1PreparedStatement {
  return env.DB.prepare("DELETE FROM draft_handoffs WHERE group_id = ?1").bind(groupId);
}

function isLineup(value: unknown): value is Record<string, unknown> & { bench?: unknown[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.formatVersion === "number" &&
    Array.isArray(draft.people) &&
    draft.people.length === LINEUP_SIZE &&
    Array.isArray(draft.slots) &&
    draft.slots.length === LINEUP_SIZE &&
    (draft.bench === undefined || Array.isArray(draft.bench))
  );
}
