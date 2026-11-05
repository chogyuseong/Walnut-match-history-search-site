import type { Env } from "./env";
import { ApiError, nowIso } from "./http";

const REQUEST_RETENTION_DAYS = 14;

export interface Plan {
  /** 한 batch(트랜잭션)로 실행할 문장들. 하나라도 실패하면 전부 되돌려진다. */
  statements: D1PreparedStatement[];
  /** 요청 기록에 남겨 재시도 때 그대로 돌려줄 값. */
  stored: Record<string, unknown>;
}

export interface MutationArgs {
  groupId: string;
  requestId: string;
  /** 작업 이름. 같은 요청 ID를 다른 작업에 다시 쓰면 거절한다. */
  op: string;
  /** 요청 내용. 해시해서 같은 요청인지 비교한다. */
  payload: unknown;
  /** 읽고 검증해서 실행 계획을 만든다. 검증 실패는 ApiError로 던진다. */
  build: () => Promise<Plan>;
  /** batch가 제약 위반으로 실패했을 때 돌려줄 오류의 부가 정보. */
  conflictDetails?: () => Promise<unknown>;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function findRequest(
  env: Env,
  groupId: string,
  requestId: string,
): Promise<{ payload_hash: string; response: string } | null> {
  return env.DB.prepare(
    "SELECT payload_hash, response FROM requests WHERE group_id = ?1 AND request_id = ?2",
  )
    .bind(groupId, requestId)
    .first<{ payload_hash: string; response: string }>();
}

function replay(
  found: { payload_hash: string; response: string },
  hash: string,
): Record<string, unknown> {
  if (found.payload_hash !== hash) {
    throw new ApiError(
      409,
      "REQUEST_ID_REUSED",
      "같은 요청 ID로 다른 내용을 보낼 수 없습니다.",
    );
  }
  return JSON.parse(found.response) as Record<string, unknown>;
}

/**
 * 변경 요청의 공통 경로.
 * 1) 같은 요청 ID가 이미 처리됐으면 저장된 결과를 돌려준다.
 * 2) 계획을 만들고, 요청 기록과 함께 한 batch로 실행한다.
 * 3) 실패하면 아무것도 남지 않는다.
 */
export async function runMutation(
  env: Env,
  args: MutationArgs,
): Promise<{ stored: Record<string, unknown>; replayed: boolean }> {
  const hash = await sha256Hex(`${args.op}\n${JSON.stringify(args.payload)}`);

  const before = await findRequest(env, args.groupId, args.requestId);
  if (before) return { stored: replay(before, hash), replayed: true };

  const group = await env.DB.prepare("SELECT maintenance FROM groups WHERE id = ?1")
    .bind(args.groupId)
    .first<{ maintenance: number }>();
  if (!group) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  if (group.maintenance === 1) {
    throw new ApiError(503, "MAINTENANCE", "모임을 점검하는 중입니다. 잠시 뒤 다시 시도해 주세요.");
  }

  const plan = await args.build();
  const now = nowIso();
  const cutoff = new Date(Date.now() - REQUEST_RETENTION_DAYS * 86400_000).toISOString();
  const statements = [
    ...plan.statements,
    env.DB.prepare(
      `INSERT INTO requests (group_id, request_id, op, payload_hash, response, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(args.groupId, args.requestId, args.op, hash, JSON.stringify(plan.stored), now),
    env.DB.prepare("DELETE FROM requests WHERE group_id = ?1 AND created_at < ?2").bind(
      args.groupId,
      cutoff,
    ),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    // 같은 요청이 동시에 먼저 처리됐을 수 있다.
    const after = await findRequest(env, args.groupId, args.requestId);
    if (after) return { stored: replay(after, hash), replayed: true };

    const message = error instanceof Error ? error.message : String(error);
    const details = args.conflictDetails ? await args.conflictDetails() : undefined;
    if (
      message.includes("guard_version_conflict") ||
      message.includes("guard_state_conflict") ||
      message.includes("uq_matches_in_progress") ||
      message.includes("matches.group_id") ||
      message.includes("uq_sessions_open") ||
      message.includes("sessions.group_id")
    ) {
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        "그 사이 내용이 바뀌었습니다. 최신 상태를 확인해 주세요.",
        details,
      );
    }
    if (message.includes("uq_rotation_used") || message.includes("rotation_events.")) {
      throw new ApiError(
        409,
        "ROTATION_CONFLICT",
        "서포터 차례 기록이 그 사이 바뀌었습니다. 최신 상태를 확인해 주세요.",
        details,
      );
    }
    throw error;
  }
  return { stored: plan.stored, replayed: false };
}

/** 진행 상태 버전이 기대값과 다르면 batch를 실패시키는 보호 문장. */
export function liveVersionGuard(env: Env, groupId: string, expected: number): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (version_conflict)
     SELECT 1 WHERE NOT EXISTS (
       SELECT 1 FROM groups WHERE id = ?1 AND live_version = ?2
     )`,
  ).bind(groupId, expected);
}

/** 경기 버전이나 상태가 기대와 다르면 batch를 실패시키는 보호 문장. */
export function matchGuard(
  env: Env,
  groupId: string,
  matchId: string,
  expectedVersion: number,
  expectedState: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (version_conflict)
     SELECT 1 WHERE NOT EXISTS (
       SELECT 1 FROM matches
       WHERE id = ?1 AND group_id = ?2 AND version = ?3 AND state = ?4
     )`,
  ).bind(matchId, groupId, expectedVersion, expectedState);
}

export function bumpLiveVersion(env: Env, groupId: string): D1PreparedStatement {
  return env.DB.prepare("UPDATE groups SET live_version = live_version + 1 WHERE id = ?1").bind(
    groupId,
  );
}

export function insertRevision(
  env: Env,
  groupId: string,
  matchId: string,
  kind: string,
  changes: Record<string, { from: unknown; to: unknown }>,
  at: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO match_revisions (group_id, match_id, kind, changes, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(groupId, matchId, kind, JSON.stringify(changes), at);
}
