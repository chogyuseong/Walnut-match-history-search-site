import type { Env } from "./env";
import { ApiError, nowIso } from "./http";

const REQUEST_RETENTION_DAYS = 14;

export interface Plan {
  /** 한 batch(트랜잭션)로 실행할 문장들. 하나라도 실패하면 전부 되돌려진다. */
  statements: D1PreparedStatement[];
  /** 요청 기록에 남겨 재시도 때 그대로 돌려줄 값. */
  stored: Record<string, unknown>;
  /**
   * 한 batch에 다 넣지 못하는 큰 작업(백업 복원)만 쓴다. statements보다 먼저 차례로 실행하는 batch들.
   * 첫 batch는 모임을 점검 상태(maintenance = 1)로 바꿔야 하고, 마지막(statements)이 점검을 푼다.
   * 첫 batch가 실패하면 아무것도 바뀌지 않는다. 그 뒤에 실패하면 점검 상태가 남아 다른 쓰기는 거절되고,
   * 같은 작업을 다시 실행해 끝낼 수 있어야 한다(allowMaintenance).
   */
  stages?: D1PreparedStatement[][];
  /**
   * 단계 실행 뒤 실패했을 때(점검 상태가 남을 때) 한 번 실행해 보는 문장. 복원은 여기서 작업 잠금을 놓아
   * 같은 파일로 바로 다시 복원할 수 있게 한다. 실패해도 무시한다(잠금은 시간이 지나면 이어받을 수 있다).
   */
  release?: D1PreparedStatement[];
}

export interface MutationArgs {
  groupId: string;
  requestId: string;
  /** 작업 이름. 같은 요청 ID를 다른 작업에 다시 쓰면 거절한다. */
  op: string;
  /** 요청 내용. 해시해서 같은 요청인지 비교한다. */
  payload: unknown;
  /**
   * 요청 본문 원문(JSON 텍스트). 있으면 payload를 다시 직렬화하지 않고 이것을 해시한다(백업 복원처럼 수 MB 본문의
   * CPU를 아끼려는 것. 8MB 본문에서 약 2ms). 원문 전체(요청 ID·확인 문구 포함)가 payload의 내용을 모두 담고 있어야 한다:
   * 같은 요청 ID + 같은 본문이면 같은 요청이라는 뜻은 그대로다. 같은 내용이라도 바이트가 다르면(공백·키 순서) 다른
   * 요청으로 보지만, 재시도는 같은 본문을 그대로 다시 보내므로 문제가 없다.
   */
  payloadText?: string;
  /** 읽고 검증해서 실행 계획을 만든다. 검증 실패는 ApiError로 던진다. */
  build: () => Promise<Plan>;
  /** batch가 제약 위반으로 실패했을 때 돌려줄 오류의 부가 정보. */
  conflictDetails?: () => Promise<unknown>;
  /** 점검 중인 모임에서도 이 요청을 받아들일지. 끊긴 복원을 다시 실행할 때만 true를 돌려준다. */
  allowMaintenance?: () => Promise<boolean>;
  /** 단계(stages)마다 끝난 뒤 부른다. 테스트에서 "중간에 끊긴 복원"을 만들 때 쓴다. */
  onStageDone?: (index: number) => void | Promise<void>;
}

const RESTORE_INCOMPLETE_MESSAGE =
  "복원이 중간에 멈췄습니다. 모임은 점검 상태로 두었습니다. 같은 백업 파일로 복원을 다시 실행하면 끝납니다.";

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
  // 원문 해시는 "raw:"로 구분한다(직렬화 해시와 우연히 같은 값이 될 일이 없게).
  const hash = await sha256Hex(
    args.payloadText !== undefined ? `${args.op}\nraw:${args.payloadText}` : `${args.op}\n${JSON.stringify(args.payload)}`,
  );

  const before = await findRequest(env, args.groupId, args.requestId);
  if (before) return { stored: replay(before, hash), replayed: true };

  const group = await env.DB.prepare("SELECT maintenance FROM groups WHERE id = ?1")
    .bind(args.groupId)
    .first<{ maintenance: number }>();
  if (!group) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  if (group.maintenance === 1 && !(args.allowMaintenance && (await args.allowMaintenance()))) {
    throw maintenanceError();
  }

  const plan = await args.build();
  // 위의 확인은 batch 밖의 읽기라, 확인과 batch 사이에 복원·모임 삭제가 점검을 켤 수 있다. 그래서 점검을 허용하지
  // 않는 요청은 첫 batch 맨 앞에 보호 문장을 넣어 batch 안에서 다시 확인한다(실패하면 classifyBatchError가
  // maintenanceError로 바꾼다). allowMaintenance가 있는 요청(복원)은 넣지 않는다: 스스로 점검을 켜고 이어 가며,
  // 겹치는 실행은 작업 잠금(claimJob·jobOwnerGuard)이 막는다.
  if (!args.allowMaintenance) {
    if (plan.stages && plan.stages.length > 0) {
      plan.stages = [[maintenanceGuard(env, args.groupId), ...plan.stages[0]!], ...plan.stages.slice(1)];
    } else {
      plan.statements = [maintenanceGuard(env, args.groupId), ...plan.statements];
    }
  }
  const stages = plan.stages ?? [];
  // 단계 도중 실패: 다른 실행이 작업을 이어받아 주인 확인에서 멈췄으면 그 실행에 맡기고, 아니면 잠금을 놓는다.
  const incomplete = async (error: unknown): Promise<ApiError> => {
    if (isJobBusy(error)) return takenOverError();
    if (plan.release && plan.release.length > 0) {
      try {
        await env.DB.batch(plan.release);
      } catch {
        // 놓지 못하면 JOB_STALE_MS 뒤에 이어받을 수 있다.
      }
    }
    return new ApiError(503, "RESTORE_INCOMPLETE", RESTORE_INCOMPLETE_MESSAGE);
  };
  for (let i = 0; i < stages.length; i++) {
    let ran = false;
    try {
      await env.DB.batch(stages[i]!);
      ran = true;
      await args.onStageDone?.(i);
    } catch (error) {
      // 첫 단계가 실패하면 아무것도 바뀌지 않았다: 보통의 실패처럼 다룬다.
      if (i === 0 && !ran) throw await classifyBatchError(args, error);
      throw await incomplete(error);
    }
  }
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
    // 단계 실행 뒤 마지막 batch가 실패하면 점검 상태가 남는다.
    if (stages.length > 0) throw await incomplete(error);
    throw await classifyBatchError(args, error);
  }
  return { stored: plan.stored, replayed: false };
}

export function maintenanceError(): ApiError {
  return new ApiError(
    503,
    "MAINTENANCE",
    "모임을 점검하는 중입니다(백업 복원 중). 잠시 뒤 화면을 새로 고친 뒤 다시 시도해 주세요. 입력한 내용은 그대로 있어요.",
  );
}

/** 모임이 점검 중이면 batch를 실패시키는 보호 문장(guard_maintenance, migrations/0022). 행 1개만 읽는다. */
export function maintenanceGuard(env: Env, groupId: string): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO guard (maintenance) SELECT 1 FROM groups WHERE id = ?1 AND maintenance = 1",
  ).bind(groupId);
}

/** 복원·삭제 작업 잠금의 주인 확인(guard_job_busy, migrations/0008)에 걸린 실패인지. */
function isJobBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("guard_job_busy");
}

function takenOverError(): ApiError {
  return new ApiError(
    409,
    "RESTORE_IN_PROGRESS",
    "다른 복원(또는 모임 삭제)이 이 작업을 이어받아 이 요청은 멈췄습니다. 화면을 새로 고쳐 결과를 확인해 주세요.",
  );
}

/** batch 실패를 화면이 이해하는 오류로 바꾼다. */
async function classifyBatchError(args: MutationArgs, error: unknown): Promise<unknown> {
  const message = error instanceof Error ? error.message : String(error);
  // 확인 뒤 batch 전에 복원·모임 삭제가 점검을 켰다(maintenanceGuard).
  if (message.includes("guard_maintenance")) return maintenanceError();
  if (isJobBusy(error)) {
    return new ApiError(
      409,
      "RESTORE_IN_PROGRESS",
      "이 모임에서 다른 복원이 진행 중입니다. 잠시 뒤 화면을 새로 고쳐 확인해 주세요. 기존 기록은 그대로입니다.",
    );
  }
  const details = args.conflictDetails ? await args.conflictDetails() : undefined;
  if (
    message.includes("guard_version_conflict") ||
    message.includes("guard_state_conflict") ||
    message.includes("uq_matches_in_progress") ||
    message.includes("matches.group_id") ||
    message.includes("uq_sessions_open") ||
    message.includes("sessions.group_id") ||
    // 시리즈: 같은 경기가 그 사이 다른 시리즈에 들어감(기본 키 match_id).
    message.includes("match_series_members.")
  ) {
    return new ApiError(
      409,
      "VERSION_CONFLICT",
      "그 사이 내용이 바뀌었습니다. 최신 상태를 확인해 주세요.",
      details,
    );
  }
  if (message.includes("uq_rotation_used") || message.includes("rotation_events.")) {
    return new ApiError(
      409,
      "ROTATION_CONFLICT",
      "서포터 차례 기록이 그 사이 바뀌었습니다. 최신 상태를 확인해 주세요.",
      details,
    );
  }
  return error;
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
