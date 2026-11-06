import { resolveMerged } from "../shared/merge";
import type { ParticipantView, SupportAdjustmentView } from "../shared/types";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, nowIso, requireInt, requireString } from "./http";
import { bumpLiveVersion, liveVersionGuard, runMutation } from "./mutation";
import { loadGroup, loadOpenSession } from "./snapshot";

/**
 * 서포터 횟수 직접 입력(migrations/0012_support_adjustments.sql).
 * 표시·규칙에 쓰는 횟수 = 주기의 유효 사건 수 + 보정값(0 미만이면 0). 계산은 기기(rotationContext)가 한다.
 * 보정값은 지금 활성 주기에 붙는다. 활성 주기가 없으면(첫 경기 전) cycle_id NULL로 받아 두고,
 * 다음 경기 시작이 새 주기를 열 때 그 주기로 옮긴다(matches.ts startMatch).
 * 합쳐진 사람의 보정값은 옮기지 않고, 보여줄 때 남은 사람 쪽에 더한다(합치기 되돌리기가 그대로 된다).
 */

type Body = Record<string, unknown>;

export const MAX_SUPPORT_COUNT = 99;
const MAX_ENTRIES = 200;

/** 활성 주기 ID. 열린 내전이 없거나 주기가 없으면 null. */
export async function activeCycleId(env: Env, groupId: string): Promise<string | null> {
  const session = await loadOpenSession(env, groupId);
  if (!session) return null;
  const row = await env.DB.prepare(
    "SELECT id FROM rotation_cycles WHERE session_id = ?1 AND status = 'active'",
  )
    .bind(session.id)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function loadRows(
  env: Env,
  groupId: string,
  cycleId: string | null,
): Promise<{ participant_id: string; delta: number }[]> {
  const rows = await env.DB.prepare(
    "SELECT participant_id, delta FROM support_adjustments WHERE group_id = ?1 AND cycle_id IS ?2",
  )
    .bind(groupId, cycleId)
    .all<{ participant_id: string; delta: number }>();
  return rows.results;
}

/** 합쳐진 사람의 보정값을 끝까지 따라가 남은 사람에게 더한다. 0인 항목은 뺀다. */
function fold(
  rows: readonly { participant_id: string; delta: number }[],
  participants: readonly Pick<ParticipantView, "id" | "mergedInto">[],
): Map<string, number> {
  const sum = new Map<string, number>();
  for (const r of rows) {
    const id = resolveMerged(participants, r.participant_id);
    sum.set(id, (sum.get(id) ?? 0) + r.delta);
  }
  for (const [id, delta] of sum) if (delta === 0) sum.delete(id);
  return sum;
}

/** 스냅숏(운영자)에 내려줄 보정값. 활성 주기의 것, 주기가 없으면 첫 경기 전에 받아 둔 것. */
export async function loadAdjustmentsView(
  env: Env,
  groupId: string,
  cycleId: string | null,
  participants: readonly Pick<ParticipantView, "id" | "mergedInto">[],
): Promise<SupportAdjustmentView[]> {
  const folded = fold(await loadRows(env, groupId, cycleId), participants);
  return [...folded].map(([participantId, delta]) => ({ participantId, delta }));
}

/**
 * 사람별 서포터 횟수를 정한다. 여러 사람을 한 요청으로. 나중에 저장한 값이 이긴다.
 * 그 시점 사건 수(+ 이 사람에게 합쳐진 사람의 보정값)와의 차이를 보정값으로 저장한다.
 * 읽은 뒤 저장 전에 경기가 시작되는 등 상태가 바뀌면 보호 문장이 막는다(다시 시도하면 새 사건 수로 계산한다).
 */
export async function saveSupportCounts(env: Env, groupId: string, body: Body): Promise<void> {
  assertOnlyKeys(body, ["requestId", "counts"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  if (!Array.isArray(body.counts) || body.counts.length === 0 || body.counts.length > MAX_ENTRIES) {
    throw new ApiError(400, "INVALID_FIELD", "counts 값이 올바르지 않습니다.");
  }
  const counts = body.counts.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ApiError(400, "INVALID_FIELD", "counts 값이 올바르지 않습니다.");
    }
    const e = entry as Body;
    assertOnlyKeys(e, ["participantId", "count"]);
    const count = requireInt(e.count, "count");
    if (count < 0 || count > MAX_SUPPORT_COUNT) {
      throw new ApiError(400, "INVALID_FIELD", `서포터 횟수는 0~${MAX_SUPPORT_COUNT} 사이로 넣어 주세요.`);
    }
    return { participantId: requireString(e.participantId, "participantId", 1, 64), count };
  });
  if (new Set(counts.map((c) => c.participantId)).size !== counts.length) {
    throw new ApiError(400, "INVALID_FIELD", "같은 사람이 두 번 들어 있습니다.");
  }

  await runMutation(env, {
    groupId,
    requestId,
    op: "support-counts",
    payload: { counts },
    conflictDetails: async () => ({ liveVersion: (await loadGroup(env, groupId)).live_version }),
    build: async () => {
      const group = await loadGroup(env, groupId);
      const people = await env.DB.prepare(
        `SELECT p.id, m.target_id AS merged_into FROM participants p
         LEFT JOIN participant_merges m ON m.source_id = p.id AND m.undone_at IS NULL
         WHERE p.group_id = ?1`,
      )
        .bind(groupId)
        .all<{ id: string; merged_into: string | null }>();
      const participants = people.results.map((p) => ({ id: p.id, mergedInto: p.merged_into ?? undefined }));
      const byId = new Map(participants.map((p) => [p.id, p]));
      for (const c of counts) {
        const p = byId.get(c.participantId);
        // 다른 모임의 참가자는 없는 것과 같은 답을 준다.
        if (!p) throw new ApiError(404, "NOT_FOUND", "참가자를 찾을 수 없습니다.");
        if (p.mergedInto) {
          throw new ApiError(409, "ALREADY_MERGED", "다른 사람에게 합쳐진 이름은 횟수를 고칠 수 없어요.");
        }
      }
      const cycleId = await activeCycleId(env, groupId);
      const events = new Map<string, number>();
      if (cycleId) {
        const rows = await env.DB.prepare(
          `SELECT participant_id, COUNT(*) AS n FROM rotation_events
           WHERE cycle_id = ?1 AND voided = 0 GROUP BY participant_id`,
        )
          .bind(cycleId)
          .all<{ participant_id: string; n: number }>();
        for (const r of rows.results) events.set(r.participant_id, r.n);
      }
      // 이 사람에게 합쳐진 다른 이름의 보정값(보여줄 때 더해지는 몫).
      const rows = await loadRows(env, groupId, cycleId);
      const fromMerged = new Map<string, number>();
      for (const r of rows) {
        const target = resolveMerged(participants, r.participant_id);
        if (target !== r.participant_id) fromMerged.set(target, (fromMerged.get(target) ?? 0) + r.delta);
      }
      const now = nowIso();
      const statements: D1PreparedStatement[] = [liveVersionGuard(env, groupId, group.live_version)];
      for (const c of counts) {
        const delta = c.count - (events.get(c.participantId) ?? 0) - (fromMerged.get(c.participantId) ?? 0);
        statements.push(
          env.DB.prepare(
            "DELETE FROM support_adjustments WHERE group_id = ?1 AND cycle_id IS ?2 AND participant_id = ?3",
          ).bind(groupId, cycleId, c.participantId),
        );
        if (delta !== 0) {
          statements.push(
            env.DB.prepare(
              `INSERT INTO support_adjustments (group_id, cycle_id, participant_id, delta, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5)`,
            ).bind(groupId, cycleId, c.participantId, delta, now),
          );
        }
      }
      statements.push(bumpLiveVersion(env, groupId));
      return { stored: {}, statements };
    },
  });
}
