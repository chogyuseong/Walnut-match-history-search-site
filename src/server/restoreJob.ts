/**
 * 복원·모임 삭제의 작업 잠금(restore_jobs, migrations/0008). 여러 batch로 나눠 넣는 동안 "누가 지금 이 작업을
 * 하는지"를 작업 행에 적고, 모든 단계의 맨 앞에서 주인을 확인한다. restore.ts와 deletion.ts가 쓴다.
 */
import type { Env } from "./env";
import { ApiError } from "./http";

/**
 * 작업 행의 주인이 이만큼 단계를 끝내지 못하면 실행이 죽었다고 보고 다른 실행이 이어받는다.
 * 한 단계는 D1 batch 하나(최대 RESTORE_BATCH_BYTES)라 보통 몇 초 안에 끝난다.
 * 이 값이 너무 짧아 살아 있는 실행을 이어받아도 데이터는 섞이지 않는다: 앞 실행의 다음 단계가 주인 확인에서 실패한다.
 */
export const JOB_STALE_MS = 60_000;
/** 모임 삭제가 쓰는 작업 행 표시. 복원은 삭제 작업 행을 이어받지 않는다(삭제만 다시 실행해 끝낸다). */
export const DELETE_JOB = "delete";
/** D1(SQLite) 안의 지금 시각(유닉스 밀리초). 단계가 실제로 실행되는 시각을 쓰려고 SQL에서 계산한다. */
export const NOW_MS_SQL = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

interface JobRow {
  request_id: string | null;
  run_token: string | null;
  heartbeat_ms: number;
}

export async function readJob(env: Env, groupId: string): Promise<JobRow | null> {
  return env.DB.prepare("SELECT request_id, run_token, heartbeat_ms FROM restore_jobs WHERE group_id = ?1")
    .bind(groupId)
    .first<JobRow>();
}

/** 작업 행 주인이 살아 있는지(실패를 알고 놓지 않았고, 단계 소식이 최근에 있음). */
function jobIsLive(job: JobRow): boolean {
  return job.run_token !== null && job.heartbeat_ms >= Date.now() - JOB_STALE_MS;
}

export function jobBusyError(sameRequest: boolean): ApiError {
  return new ApiError(
    409,
    "RESTORE_IN_PROGRESS",
    sameRequest
      ? "이 복원 요청이 아직 처리 중입니다. 잠시 뒤 화면을 새로 고쳐 결과를 확인해 주세요."
      : "이 모임에서 다른 복원이 진행 중입니다. 잠시 뒤 화면을 새로 고쳐 확인해 주세요. 기존 기록은 그대로입니다.",
  );
}

/**
 * 작업 행을 이 실행(runToken)의 것으로 만든다. 행이 없으면 만들고, 있으면 아래 조건일 때만 이어받는다:
 * - 모임 삭제의 작업 행이 아니고,
 * - 주인이 없거나(앞 실행이 실패를 알고 놓음, 또는 0008 이전 버전이 남긴 행) 주인의 마지막 단계가 JOB_STALE_MS보다 오래됨.
 * 이어받지 못하면 아무것도 바꾸지 않는다. 바로 뒤의 jobOwnerGuard가 batch를 실패시킨다.
 */
export function claimJob(env: Env, groupId: string, requestId: string, runToken: string, at: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO restore_jobs (group_id, started_at, request_id, run_token, heartbeat_ms)
     VALUES (?1, ?2, ?3, ?4, ${NOW_MS_SQL})
     ON CONFLICT (group_id) DO UPDATE SET
       started_at = excluded.started_at, request_id = excluded.request_id,
       run_token = excluded.run_token, heartbeat_ms = excluded.heartbeat_ms
     WHERE restore_jobs.request_id IS NOT '${DELETE_JOB}'
       AND (restore_jobs.run_token IS NULL OR restore_jobs.heartbeat_ms < ${NOW_MS_SQL} - ?5)`,
  ).bind(groupId, at, requestId, runToken, JOB_STALE_MS);
}

/** 작업 행의 주인이 이 실행이 아니면 batch 전체를 실패시킨다(guard_job_busy). 모든 단계의 맨 앞에 둔다. */
export function jobOwnerGuard(env: Env, groupId: string, runToken: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (job_busy)
     SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM restore_jobs WHERE group_id = ?1 AND run_token = ?2)`,
  ).bind(groupId, runToken);
}

export function jobHeartbeat(env: Env, groupId: string, runToken: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE restore_jobs SET heartbeat_ms = ${NOW_MS_SQL} WHERE group_id = ?1 AND run_token = ?2`,
  ).bind(groupId, runToken);
}

/** 실패를 안 실행이 작업 행을 놓는다. 같은 파일(또는 다른 요청)로 바로 다시 복원해 끝낼 수 있게 된다. */
export function jobRelease(env: Env, groupId: string, runToken: string): D1PreparedStatement {
  return env.DB.prepare("UPDATE restore_jobs SET run_token = NULL WHERE group_id = ?1 AND run_token = ?2").bind(
    groupId,
    runToken,
  );
}

/**
 * 점검 중인 모임에서 복원을 받아들일지(runMutation의 allowMaintenance).
 * - 작업 행이 없거나 모임 삭제의 작업 행이면 받지 않는다(점검 오류).
 * - 주인이 살아 있으면 409(RESTORE_IN_PROGRESS). 같은 요청 ID의 재전송이 앞 실행과 겹친 경우도 여기서 막는다.
 * 미리 보는 확인일 뿐이고, 실제 잠금은 batch 안의 claimJob + jobOwnerGuard다.
 */
export async function canResumeRestore(env: Env, groupId: string, requestId: string): Promise<boolean> {
  const job = await readJob(env, groupId);
  if (!job || job.request_id === DELETE_JOB) return false;
  if (jobIsLive(job)) throw jobBusyError(job.request_id === requestId);
  return true;
}
