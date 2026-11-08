/**
 * 자동 백업(예정 작업, Cron Trigger). docs/개선-서버-2026-11-07.md, docs/배포안내.md 13-4절.
 *
 * - 모든 모임의 백업 JSON을 하루 한 번 R2 버킷(BACKUPS)에 `backups/{모임 ID}/{YYYY-MM-DD}.json`으로 넣는다.
 *   내용은 화면의 "백업 내려받기"와 같은 함수(exportBackup)·같은 형식이다. 그대로 "백업에서 복원"에 쓸 수 있다.
 *   날짜는 한국 시각(KST) 기준이다.
 * - Workers 무료 요금제는 예정 작업도 실행당 CPU 10ms다. 그래서 한 실행에 모임을 BACKUP_GROUPS_PER_RUN개(기본 5)까지만
 *   하나씩 처리하고, 나머지는 다음 실행이 이어서 한다(wrangler.jsonc의 크론이 새벽 두 시간 동안 10분마다 돈다).
 *   고르는 순서: 오늘(KST) 아직 끝나지 않은 모임 중 마지막으로 시도한 지 오래된 것부터(backup_tried_at).
 *   처리하기 전에 시도 시각을 먼저 적으므로, 어떤 모임에서 실행이 끊겨도(CPU 한도 등) 다음 실행은 그 모임을
 *   맨 뒤로 미루고 다른 모임을 먼저 한다(한 모임이 나머지를 막지 않는다).
 * - 넣은 뒤 그 모임의 BACKUP_KEEP_DAYS일(기본 30)보다 오래된 백업을 지운다(키의 날짜로 판단).
 * - 점검 중(복원·삭제 진행 중)인 모임은 건너뛴다(반쯤 바뀐 상태를 백업하지 않는다).
 * - 모임마다 걸린 시간(벽시계 ms)·크기를 로그(Workers Logs)에 남긴다. 모임 이름·내용은 남기지 않는다.
 *
 * 한계: 지운 모임의 지난 백업은 이 코드가 지우지 않는다(모임 목록에 없으므로). R2 수명 주기 규칙
 * (backups/ 접두어, 30일)을 함께 걸어 둔다(docs/배포안내.md).
 */
import type { Env } from "./env";
import { exportBackup } from "./groups";
import { nowIso } from "./http";

const DEFAULT_GROUPS_PER_RUN = 5;
const DEFAULT_KEEP_DAYS = 30;
const KST_OFFSET_MS = 9 * 3600_000;
const DAY_MS = 24 * 3600_000;

export const BACKUP_PREFIX = "backups/";

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** 시각(ms)의 한국 날짜(YYYY-MM-DD). */
export function kstDay(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 그 한국 날짜가 시작하는 시각(UTC ISO). */
function kstDayStartIso(ms: number): string {
  const start = Math.floor((ms + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
  return new Date(start).toISOString();
}

export function backupKey(groupId: string, day: string): string {
  return `${BACKUP_PREFIX}${groupId}/${day}.json`;
}

export interface BackupRunResult {
  /** 이번 실행에서 넣은 모임 수. */
  done: number;
  /** 실패한 모임 수(다음 실행이 다시 시도한다). */
  failed: number;
  /** 지운 오래된 백업 수. */
  pruned: number;
  /** 오늘 아직 남은 모임이 있는지(한도 때문에 멈춤). */
  more: boolean;
}

/**
 * 한 번 실행한다. 예정 작업(scheduled)과 테스트가 부른다.
 * now: 기준 시각(ms). 예정 작업은 controller.scheduledTime을 넘긴다.
 */
export async function runBackups(env: Env, now = Date.now()): Promise<BackupRunResult> {
  const result: BackupRunResult = { done: 0, failed: 0, pruned: 0, more: false };
  if (!env.BACKUPS) {
    console.error(JSON.stringify({ at: nowIso(), backup: "skipped", reason: "BACKUPS 바인딩 없음" }));
    return result;
  }
  const perRun = positiveInt(env.BACKUP_GROUPS_PER_RUN, DEFAULT_GROUPS_PER_RUN);
  const keepDays = positiveInt(env.BACKUP_KEEP_DAYS, DEFAULT_KEEP_DAYS);
  const day = kstDay(now);
  const dayStart = kstDayStartIso(now);
  // 한도보다 하나 더 읽어 "더 남았는지"를 안다.
  const rows = await env.DB.prepare(
    `SELECT id FROM groups
     WHERE maintenance = 0 AND (backup_done_at IS NULL OR backup_done_at < ?1)
     ORDER BY backup_tried_at IS NOT NULL, backup_tried_at, id
     LIMIT ?2`,
  )
    .bind(dayStart, perRun + 1)
    .all<{ id: string }>();
  const targets = rows.results.slice(0, perRun);
  result.more = rows.results.length > perRun;

  for (const { id } of targets) {
    const started = Date.now();
    try {
      // 먼저 시도 시각을 적는다: 이 모임에서 실행이 끊기면 다음 실행은 이 모임을 맨 뒤로 미룬다.
      await env.DB.prepare("UPDATE groups SET backup_tried_at = ?2 WHERE id = ?1").bind(id, new Date(now).toISOString()).run();
      const body = JSON.stringify(await exportBackup(env, id));
      await env.BACKUPS.put(backupKey(id, day), body, {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { groupId: id, day },
      });
      await env.DB.prepare("UPDATE groups SET backup_done_at = ?2 WHERE id = ?1").bind(id, new Date(now).toISOString()).run();
      const pruned = await pruneOld(env.BACKUPS, id, now, keepDays);
      result.pruned += pruned;
      result.done += 1;
      console.log(
        // ms: 벽시계 시간(D1·R2 대기 포함). CPU 시간은 Workers Logs의 요청 기록(cpuTime)에서 본다. chars: JSON 글자 수.
        JSON.stringify({ at: nowIso(), backup: "done", group: id, day, chars: body.length, ms: Date.now() - started, pruned }),
      );
    } catch (error) {
      result.failed += 1;
      // 오류 내용(모임 자료가 섞일 수 있는 메시지)은 짧게만 남긴다.
      console.error(
        JSON.stringify({
          at: nowIso(),
          backup: "failed",
          group: id,
          ms: Date.now() - started,
          error: String(error instanceof Error ? error.message : error).slice(0, 200),
        }),
      );
    }
  }
  return result;
}

/** 이 모임의 백업 중 keepDays일보다 오래된 것(키의 날짜 기준)을 지운다. 지운 수를 돌려준다. */
export async function pruneOld(bucket: R2Bucket, groupId: string, now: number, keepDays: number): Promise<number> {
  const oldest = kstDay(now - keepDays * DAY_MS);
  const prefix = `${BACKUP_PREFIX}${groupId}/`;
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    for (const object of listed.objects) {
      const name = object.key.slice(prefix.length).replace(/\.json$/, "");
      if (/^\d{4}-\d{2}-\d{2}$/.test(name) && name < oldest) stale.push(object.key);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  if (stale.length > 0) await bucket.delete(stale);
  return stale.length;
}

/** 사이트 현황(#/admin)에 싣는 자동 백업 상태. 모임 이름은 넣지 않는다. */
export async function backupStatus(env: Env, now = Date.now()): Promise<{
  enabled: boolean;
  lastBackupAt: string | null;
  backedUpToday: number;
  pendingToday: number;
}> {
  const row = await env.DB.prepare(
    `SELECT MAX(backup_done_at) AS last_at,
       SUM(CASE WHEN backup_done_at >= ?1 THEN 1 ELSE 0 END) AS today,
       SUM(CASE WHEN maintenance = 0 AND (backup_done_at IS NULL OR backup_done_at < ?1) THEN 1 ELSE 0 END) AS pending
     FROM groups`,
  )
    .bind(kstDayStartIso(now))
    .first<{ last_at: string | null; today: number | null; pending: number | null }>();
  return {
    enabled: Boolean(env.BACKUPS),
    lastBackupAt: row?.last_at ?? null,
    backedUpToday: Number(row?.today ?? 0),
    pendingToday: Number(row?.pending ?? 0),
  };
}
