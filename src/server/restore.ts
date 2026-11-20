/**
 * 백업 복원·가져오기(docs/P4 P4-3, 검증 시나리오 36·37·38).
 *
 * - 같은 모임 복구: 파일의 모임 ID가 대상 모임과 같을 때. ID를 그대로 쓰고 그 모임의 경기·참가자·이력·
 *   세션·순환·시즌·설정 버전을 파일 내용으로 바꾼다. 운영자·조회 토큰·인수 링크는 건드리지 않는다.
 * - 새 모임 가져오기: 다른 모임(또는 빈 환경)의 파일. 모든 ID를 새로 만들고 파일 안의 참조를 대응표로 바꾼다.
 *   다른 모임의 파일로 기존 모임을 덮어쓰는 길은 두지 않는다.
 *
 * 순서: 파일 전체 검증(아무것도 쓰지 않음) → 실행 계획 → 적용.
 * 적용은 D1 batch(한 트랜잭션, docs/구현현황/2026-11-05.md 스파이크)로 한다. 데이터가 커서 한 batch에 넣기 부담스러우면
 * 모임을 점검 상태로 바꾼 뒤 여러 batch로 나눠 넣고 마지막 batch에서 점검을 푼다. 중간에 끊기면 점검 상태가
 * 남고(다른 쓰기는 거절), 같은 백업 파일로 다시 복원하면 처음부터 다시 지우고 넣어 끝난다.
 *
 * 행은 json_each로 넣는다: 문장 하나에 행 수천 개를 JSON 문자열 값 하나로 실어 보낸다.
 * D1 한도(2026-11-05 확인, https://developers.cloudflare.com/d1/platform/limits/):
 * 문장 길이 100KB, 문장당 바인딩 값 100개, 문자열·행 2MB. batch 문장 수 상한은 문서에 없다.
 *
 * 나눈 파일: 파일 검증은 restoreChecks.ts, 작업 잠금은 restoreJob.ts, 행 넣기 부품(묶음 나누기·ID 대응표)은 restoreRows.ts.
 */
import type { Env } from "./env";
import { accountGroupCount, groupLimitGuard, isGroupLimitError, MAX_GROUPS_PER_ACCOUNT, tooManyGroupsError } from "./groups";
import { ApiError, assertOnlyKeys, nowIso, readJsonBody, readJsonBodyWithText, requireInt, requireRequestId } from "./http";
import { ANON_NAME_PATTERN, MAX_LINKS_PER_ACCOUNT } from "./members";
import type { MovedLink } from "./merge";
import { runMutation, sha256Hex, type Plan } from "./mutation";
import { newViewToken } from "./auth";
import { spendBulkRows, type BulkActor } from "./ratelimit";
import { invalid, validateBackup, type BackupData, type Body } from "./restoreChecks";
import { canResumeRestore, claimJob, jobHeartbeat, jobOwnerGuard, jobRelease, readJob } from "./restoreJob";
import { batchBytesOf, CHUNK_BYTES, idMapper, insertStatements, remapChanges } from "./restoreRows";

export const RESTORE_CONFIRM_TEXT = "복원";

/**
 * 모임 데이터 표를 외래 키 순서(참조하는 쪽 먼저)로 적은 목록. 같은 모임 복원과 모임 삭제(deletion.ts)가 함께 쓴다.
 * 참가자·경기를 참조하는 표를 새로 만들면 여기에 넣어야 한다. 빠지면 외래 키 때문에 복원·삭제가 실패한다.
 * 운영자·조회 토큰·인수 링크·복원 작업 표는 들어가지 않는다(복원이 바꾸지 않는 것).
 */
export const GROUP_DATA_TABLES = [
  // 넘긴 편성(migrations/0029). 기기 사이에 잠깐 건네는 자료라 백업에 넣지 않고, 복원하면 비워진다.
  "draft_handoffs",
  // 참가 신청(migrations/0014). 그날그날 쓰는 임시 자료라 백업에 넣지 않고, 복원하면 비워진다.
  "join_requests",
  "support_adjustments",
  "rotation_events",
  // 시리즈에 속한 경기(migrations/0017). 경기·시리즈보다 먼저 지운다.
  "match_series_members",
  "match_revisions",
  "match_roster",
  "participant_merges",
  "import_batches",
  "rotation_cycles",
  "matches",
  "match_series",
  "sessions",
  "seasons",
  "participants",
  "settings_versions",
  "requests",
] as const;
export const MAX_RESTORE_BODY_BYTES = 8 * 1024 * 1024;

/** 테스트 전용: 단계 사이에 끼어들어 "중간에 끊긴 복원"을 만든다. */
export const restoreHooks: { afterStage: ((index: number) => void | Promise<void>) | null } = {
  afterStage: null,
};

/* ------------------------------------------------------------------ */
/* 요약                                                                 */
/* ------------------------------------------------------------------ */

export interface RestoreCounts {
  matches: number;
  confirmed: number;
  participants: number;
}

/** 복원 확인 화면에 보이는 수. 지운 경기는 화면에 없으므로 세지 않는다(파일·지금 DB 모두). */
function countsOf(data: BackupData): RestoreCounts {
  const alive = data.matches.filter((m) => m.deletedAt === null);
  return {
    matches: alive.length,
    confirmed: alive.filter((m) => m.state === "confirmed").length,
    participants: data.participants.length,
  };
}

async function currentCounts(env: Env, groupId: string): Promise<RestoreCounts> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM matches WHERE group_id = ?1 AND deleted_at IS NULL) AS matches,
       (SELECT COUNT(*) FROM matches WHERE group_id = ?1 AND state = 'confirmed' AND deleted_at IS NULL) AS confirmed,
       (SELECT COUNT(*) FROM participants WHERE group_id = ?1) AS participants`,
  )
    .bind(groupId)
    .first<RestoreCounts>();
  return row ?? { matches: 0, confirmed: 0, participants: 0 };
}

/** 같은 모임 복구에서 파일의 ID가 다른 모임의 행과 겹치는지 확인한다(손으로 고친 파일 대비). */
async function foreignIdCollision(env: Env, groupId: string, data: BackupData): Promise<string | null> {
  const checks: [string, string[]][] = [
    ["participants", data.participants.map((r) => r.id)],
    ["matches", data.matches.map((r) => r.id)],
    ["sessions", data.sessions.map((r) => r.id)],
    ["rotation_cycles", data.cycles.map((r) => r.id)],
    ["rotation_events", data.events.map((r) => r.id)],
    ["seasons", data.seasons.map((r) => r.id)],
    ["settings_versions", data.settingsVersions.map((r) => r.id)],
    ["participant_merges", data.merges.map((r) => r.id)],
    ["match_series", data.series.map((r) => r.id)],
  ];
  // 표마다 따로 기다리면 D1까지 최대 9번 왕복한다. batch 한 번으로 묻고, 겹친 표 중 위 순서의 첫 번째를 알린다.
  const asked = checks.filter(([, ids]) => ids.length > 0);
  if (asked.length === 0) return null;
  const results = await env.DB.batch<{ n: number }>(
    asked.map(([table, ids]) =>
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${table} WHERE group_id <> ?1 AND id IN (SELECT value FROM json_each(?2))`,
      ).bind(groupId, JSON.stringify(ids)),
    ),
  );
  const hit = results.findIndex((r) => (r.results[0]?.n ?? 0) > 0);
  return hit === -1 ? null : asked[hit]![0];
}

export interface RestorePreview {
  ok: boolean;
  problems: string[];
  /** 파일이 이 모임의 백업인지. 아니면 새 모임으로만 가져올 수 있다. */
  sameGroup: boolean;
  file?: RestoreCounts & { groupName: string; createdAt: string; formatVersion: number };
  current: RestoreCounts;
  generation: number;
  confirmText: string;
}

/** 복원 미리보기: 검증 결과와 바뀌는 내용 요약. 아무것도 쓰지 않는다. */
export async function previewRestore(env: Env, groupId: string, req: Request): Promise<RestorePreview> {
  const body = await readJsonBody(req, MAX_RESTORE_BODY_BYTES);
  assertOnlyKeys(body, ["backup"]);
  const group = await env.DB.prepare("SELECT generation FROM groups WHERE id = ?1")
    .bind(groupId)
    .first<{ generation: number }>();
  if (!group) throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  const current = await currentCounts(env, groupId);
  const result = validateBackup(body.backup);
  const base = { current, generation: group.generation, confirmText: RESTORE_CONFIRM_TEXT };
  if (!result.ok) return { ok: false, problems: result.problems, sameGroup: false, ...base };
  const data = result.data;
  const sameGroup = data.group.id === groupId;
  const problems: string[] = [];
  if (sameGroup) {
    const clash = await foreignIdCollision(env, groupId, data);
    if (clash) problems.push("파일의 ID가 다른 모임의 기록과 겹칩니다. 이 파일로는 복원할 수 없습니다.");
  }
  return {
    ok: problems.length === 0,
    problems,
    sameGroup,
    file: {
      ...countsOf(data),
      groupName: data.group.name,
      createdAt: data.createdAt,
      formatVersion: data.formatVersion,
    },
    ...base,
  };
}

/* ------------------------------------------------------------------ */
/* 실행 계획                                                            */
/* ------------------------------------------------------------------ */

interface CurrentLinkRow {
  participant_id: string;
  account_id: string;
  created_at: string;
  avoid_self_at: string | null;
}

/**
 * 같은 모임 복구에서 합치기와 본인 연결을 맞춘다(2026-11-08 정합성 점검).
 *
 * 본인 연결(participant_links)·요청은 백업 밖이라 복원이 그대로 두는데, 합치기(merge.ts)는 합칠 대상의 연결을 남길
 * 대상에게 옮긴다. 그래서 "합치기 전 백업"으로 복원하면 합치기는 사라지고(합칠 대상이 다시 활성) 연결은 남길 대상에
 * 남아, 그 계정이 남의 기피 라인을 바꿀 수 있었다. 고치는 방법:
 * (a) 지금 유효한 합치기인데 파일에는 없거나 되돌린 것: 되돌리기(merge.ts undoLinkPlan)와 같은 규칙으로 연결·요청을
 *     원래 사람에게 돌려놓는다. 원래 사람에게 이미 다른 연결이 있으면 끊는다. 지웠던 연결(removed)은 원래 사람·그 계정
 *     모두 이 모임 연결이 없고 계정이 남아 있고 한도 안이고 익명 처리되지 않았을 때만 다시 만든다. 기록이 없는
 *     합치기(moved_link NULL, 0023 전·복원한 합치기)는 무엇을 옮겼는지 몰라 건드리지 않는다(되돌리기와 같다).
 *     나중에 한 합치기부터 차례로 처리하고(이어진 합치기 A→B→C), 연결 상태는 JS로 따라가며 문장을 만든다.
 *     undoLinkPlan을 합치기마다 부르지 않는 이유: 합치기마다 질의 1~2회라 무료 요금제 한도(호출당 50회)에 닿을 수 있고,
 *     이어진 합치기에서 앞 처리의 결과를 보지 못한다. 질의는 합치기 수와 상관없이 2회다.
 * (b) 지금도 파일에도 유효한 합치기: moved_link를 그대로 넣는다(예전에는 NULL이 되어 그 뒤 되돌리면 연결을 돌려놓지 못했다).
 * 읽은 뒤 연결이 바뀌었으면 첫 batch의 보호 문장이 막는다(VERSION_CONFLICT, 다시 시도하면 새로 판단한다).
 *
 * 남는 한계: 파일에는 유효하지만 지금은 되돌린 합치기를 복원하면 연결은 합칠 대상(보관됨)에 그대로 남는다.
 * 그 계정은 보관된 자기 이름만 다루므로 남의 것을 바꿀 수는 없다.
 */
async function rewindMergeLinks(
  env: Env,
  groupId: string,
  data: BackupData,
): Promise<{ statements: D1PreparedStatement[]; keepMovedLink: Map<string, string | null> }> {
  const [mergeRows, linkRows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, source_id, target_id, created_at, undone_at, moved_link
       FROM participant_merges WHERE group_id = ?1 ORDER BY created_at DESC, id DESC`,
    ).bind(groupId),
    env.DB.prepare(
      "SELECT participant_id, account_id, created_at, avoid_self_at FROM participant_links WHERE group_id = ?1",
    ).bind(groupId),
  ]);
  const merges = (mergeRows!.results ?? []) as {
    id: string;
    source_id: string;
    target_id: string;
    created_at: string;
    undone_at: string | null;
    moved_link: string | null;
  }[];
  const links = (linkRows!.results ?? []) as CurrentLinkRow[];
  const validInFile = new Map(data.merges.filter((m) => m.undoneAt === null).map((m) => [m.id, m]));
  const names = new Map(data.participants.map((p) => [p.id, p.name]));
  const keepMovedLink = new Map<string, string | null>();
  const statements: D1PreparedStatement[] = [];

  // 연결 상태를 따라간다: 참가자 → 연결, 계정 → 참가자.
  const byParticipant = new Map(links.map((l) => [l.participant_id, l]));
  const byAccount = new Map(links.map((l) => [l.account_id, l.participant_id]));
  for (const m of merges) {
    if (m.undone_at !== null) continue;
    const inFile = validInFile.get(m.id);
    if (inFile && inFile.sourceId === m.source_id && inFile.targetId === m.target_id) {
      keepMovedLink.set(m.id, m.moved_link);
      continue;
    }
    const recorded = m.moved_link === null ? null : (JSON.parse(m.moved_link) as Partial<MovedLink>);
    if (!recorded?.accountId || !recorded.action || !recorded.linkedAt) continue;
    const moved = recorded as MovedLink;
    const source = m.source_id;
    const target = m.target_id;
    if (moved.action === "moved") {
      // 합칠 때 옮긴 요청은 원래 사람의 것이라 연결 결과와 상관없이 돌려놓는다.
      statements.push(
        env.DB.prepare(
          `UPDATE participant_requests SET participant_id = ?3
           WHERE group_id = ?1 AND participant_id = ?2 AND id IN (SELECT value FROM json_each(?4))`,
        ).bind(groupId, target, source, JSON.stringify(moved.requestIds ?? [])),
      );
      if (byAccount.get(moved.accountId) !== target) continue;
      const link = byParticipant.get(target)!;
      if (byParticipant.has(source)) {
        // 원래 사람에게 이미 다른 연결이 있어 돌려놓을 수 없다: 끊는다.
        statements.push(
          env.DB.prepare(
            "DELETE FROM participant_links WHERE group_id = ?1 AND participant_id = ?2 AND account_id = ?3",
          ).bind(groupId, target, moved.accountId),
        );
        byParticipant.delete(target);
        byAccount.delete(moved.accountId);
        continue;
      }
      if (link.created_at === moved.linkedAt) {
        statements.push(
          env.DB.prepare(
            `UPDATE participant_requests SET participant_id = ?3
             WHERE group_id = ?1 AND participant_id = ?2 AND created_at >= ?4`,
          ).bind(groupId, target, source, m.created_at),
        );
      }
      statements.push(
        env.DB.prepare(
          `UPDATE participant_links SET participant_id = ?3, avoid_self_at = ?5
           WHERE group_id = ?1 AND participant_id = ?2 AND account_id = ?4`,
        ).bind(groupId, target, source, moved.accountId, moved.avoidSelfAt ?? null),
      );
      byParticipant.delete(target);
      byParticipant.set(source, { ...link, participant_id: source, avoid_self_at: moved.avoidSelfAt ?? null });
      byAccount.set(moved.accountId, source);
      continue;
    }
    // removed: 지웠던 연결을 다시 만들 수 있으면 만든다(계정 존재·연결 수 한도는 문장 안에서 확인).
    const name = names.get(source);
    if (byParticipant.has(source) || byAccount.has(moved.accountId) || name === undefined || ANON_NAME_PATTERN.test(name)) {
      continue;
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO participant_links (group_id, participant_id, account_id, created_at, avoid_self_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?3)
           AND (SELECT COUNT(*) FROM participant_links WHERE account_id = ?3) < ?6
           AND NOT EXISTS (SELECT 1 FROM participant_links WHERE group_id = ?1 AND (participant_id = ?2 OR account_id = ?3))`,
      ).bind(groupId, source, moved.accountId, moved.linkedAt, moved.avoidSelfAt ?? null, MAX_LINKS_PER_ACCOUNT),
    );
    const row = { participant_id: source, account_id: moved.accountId, created_at: moved.linkedAt, avoid_self_at: null };
    byParticipant.set(source, row);
    byAccount.set(moved.accountId, source);
  }
  if (statements.length > 0) {
    // 읽은 뒤 이 모임의 연결이 하나라도 바뀌었으면 막는다(행 수 + 읽은 행이 모두 그대로인지).
    const read = JSON.stringify(links.map((l) => [l.participant_id, l.account_id]));
    statements.unshift(
      env.DB.prepare(
        `INSERT INTO guard (state_conflict)
         SELECT 1 WHERE (SELECT COUNT(*) FROM participant_links WHERE group_id = ?1) <> ?3
           OR (SELECT COUNT(*) FROM participant_links l JOIN json_each(?2) j
                 ON l.participant_id = json_extract(j.value, '$[0]') AND l.account_id = json_extract(j.value, '$[1]')
               WHERE l.group_id = ?1) <> ?3`,
      ).bind(groupId, read, links.length),
    );
  }
  return { statements, keepMovedLink };
}

/**
 * 복원 실행 계획. stages가 있으면 runMutation이 그 batch들을 먼저 차례로 실행한다.
 * 첫 단계는 작업 잠금 + 세대 확인 + 점검 상태 전환 + 기존 행 삭제, 마지막(plan.statements)은 점검 해제·잠금 해제다.
 * 모든 batch의 맨 앞은 "작업 행의 주인 = 이 실행" 확인이라, 다른 실행이 이어받은 뒤의 늦은 단계는 아무것도 바꾸지 못한다.
 * 단계를 다시 실행해도(같은 요청 ID의 재전송) 첫 단계가 모두 지우고 처음부터 넣으므로 결과가 같다.
 */
async function buildRestorePlan(
  env: Env,
  groupId: string,
  data: BackupData,
  options: { remap: boolean; baseGeneration: number; requestId: string },
): Promise<Plan> {
  const map = idMapper(options.remap);
  const at = nowIso();
  // 오래된 탭이 들고 있는 경기 버전과 겹치지 않게, 같은 모임 복구는 경기 버전을 지금 최대값만큼 올린다.
  const offsetRow = options.remap
    ? null
    : await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM matches WHERE group_id = ?1")
        .bind(groupId)
        .first<{ v: number }>();
  const versionOffset = offsetRow?.v ?? 0;
  // 같은 모임 복구: 본인 연결은 백업 밖이라 합치기와 어긋날 수 있다(rewindMergeLinks). 파일에도 유효한 합치기는
  // 연결 기록(moved_link)을 그대로 넣어, 복원 뒤 되돌려도 연결을 원래 사람에게 돌려놓을 수 있게 한다.
  const links = options.remap ? null : await rewindMergeLinks(env, groupId, data);
  const batchMap = new Map<string, string>();
  const batchId = (id: string | null) => {
    if (id === null || !options.remap) return id;
    let mapped = batchMap.get(id);
    if (!mapped) {
      mapped = crypto.randomUUID();
      batchMap.set(id, mapped);
    }
    return mapped;
  };

  const maxBytes = Math.min(CHUNK_BYTES, batchBytesOf(env));
  const inserts = [
    ...insertStatements(env, groupId, "settings_versions", ["id", "version_no", "payload", "created_at"],
      data.settingsVersions.map((v) => [map(v.id), v.versionNo, v.payload, v.createdAt]), maxBytes),
    ...insertStatements(env, groupId, "participants",
      ["id", "name", "name_key", "skill_group", "status", "created_at", "avoid_positions"],
      data.participants.map((r) => [map(r.id), r.name, r.nameKey, r.skillGroup, r.status, r.createdAt, r.avoidPositions]),
      maxBytes),
    ...insertStatements(env, groupId, "sessions", ["id", "started_at", "last_activity_at", "closed_at"],
      data.sessions.map((s) => [map(s.id), s.startedAt, s.lastActivityAt, s.closedAt]), maxBytes),
    ...insertStatements(env, groupId, "matches",
      ["id", "match_no", "session_id", "state", "prev_state", "source", "started_at", "ended_at",
        "played_at", "confirmed_at", "winner_team", "team_a_side", "settings_version_id", "version",
        "import_batch_id", "import_fingerprint", "import_row_key", "memo", "deleted_at"],
      data.matches.map((m) => [
        map(m.id), m.matchNo, m.sessionId === null ? null : map(m.sessionId), m.state, m.prevState,
        m.source, m.startedAt, m.endedAt, m.playedAt, m.confirmedAt, m.winnerTeam, m.teamASide,
        m.settingsVersionId === null ? null : map(m.settingsVersionId), m.version + versionOffset,
        batchId(m.importBatchId), m.importFingerprint, m.importRowKey, m.memo, m.deletedAt,
      ]), maxBytes),
    // 시리즈 묶음: 경기 뒤에 넣는다(경기 외래 키). 시리즈 ID·경기 ID도 같은 대응표로 바꾼다.
    ...insertStatements(env, groupId, "match_series", ["id", "name", "format", "created_at"],
      data.series.map((r) => [map(r.id), r.name, r.format, r.createdAt]), maxBytes),
    ...insertStatements(env, groupId, "match_series_members", ["series_id", "match_id", "added_at"],
      data.series.flatMap((r) => r.matchIds.map((id) => [map(r.id), map(id), r.createdAt])), maxBytes),
    // 일괄 입력 출처: 묶음 ID는 경기의 import_batch_id와 같은 대응표로 바꾼다.
    ...insertStatements(env, groupId, "import_batches", ["id", "kind", "source_key", "label", "created_at", "options"],
      data.importBatches.map((b) => [
        batchId(b.id), b.kind, b.sourceKey, b.label, b.createdAt, b.options === null ? null : JSON.stringify(b.options),
      ]), maxBytes),
    ...insertStatements(env, groupId, "match_roster", ["match_id", "participant_id", "team", "position", "champion"],
      data.matches.flatMap((m) =>
        m.roster.map((r) => [map(m.id), map(r.participantId), r.team, r.position, r.champion])), maxBytes),
    ...insertStatements(env, groupId, "rotation_cycles",
      ["id", "session_id", "status", "created_at", "closed_at"],
      data.cycles.map((c) => [map(c.id), map(c.sessionId), c.status, c.createdAt, c.closedAt]), maxBytes),
    ...insertStatements(env, groupId, "rotation_events",
      ["id", "cycle_id", "match_id", "participant_id", "kind", "voided", "created_at"],
      data.events.map((e) => [map(e.id), map(e.cycleId), map(e.matchId), map(e.participantId), e.kind,
        e.voided, e.createdAt]), maxBytes),
    ...insertStatements(env, groupId, "support_adjustments", ["cycle_id", "participant_id", "delta", "updated_at"],
      data.adjustments.map((a) => [a.cycleId === null ? null : map(a.cycleId), map(a.participantId), a.delta,
        a.updatedAt]), maxBytes),
    ...insertStatements(env, groupId, "match_revisions", ["match_id", "kind", "changes", "created_at"],
      data.revisions.map((r) => [map(r.matchId), r.kind, remapChanges(r.changes, map), r.createdAt]), maxBytes),
    ...insertStatements(env, groupId, "seasons", ["id", "name", "starts_on", "ends_on", "created_at"],
      data.seasons.map((s) => [map(s.id), s.name, s.startsOn, s.endsOn, at]), maxBytes),
    // 합치기 기록: 참가자 뒤에 넣는다(참가자 외래 키). 안의 ID 목록도 같은 대응표로 바꾼다.
    ...insertStatements(env, groupId, "participant_merges",
      ["id", "source_id", "target_id", "source_prev_status", "moved_matches", "rotation_changes",
        "created_at", "undone_at", "moved_link"],
      data.merges.map((m) => [
        map(m.id), map(m.sourceId), map(m.targetId), m.sourcePrevStatus,
        JSON.stringify(m.movedMatches.map(map)),
        JSON.stringify(m.rotationChanges.map((c) => ({
          ...c, id: map(c.id), participantFrom: map(c.participantFrom), participantTo: map(c.participantTo),
        }))),
        m.createdAt, m.undoneAt, links?.keepMovedLink.get(m.id) ?? null,
      ]), maxBytes),
  ];

  const guard = env.DB.prepare(
    `INSERT INTO guard (version_conflict)
     SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM groups WHERE id = ?1 AND generation = ?2)`,
  ).bind(groupId, options.baseGeneration);
  // 작업 잠금: 실행마다 새 표시를 만들고, 모든 batch가 "작업 행의 주인 = 이 실행"을 확인한다.
  const runToken = crypto.randomUUID();
  const claim = claimJob(env, groupId, options.requestId, runToken, at);
  const owner = jobOwnerGuard(env, groupId, runToken);
  // 외래 키 순서대로 지운다. 운영자(group_operators)·조회 토큰·인수 링크는 지우지 않는다.
  const deletes = GROUP_DATA_TABLES.map((table) =>
    env.DB.prepare(`DELETE FROM ${table} WHERE group_id = ?1`).bind(groupId),
  );
  const nextMatchNo = data.matches.reduce((max, m) => Math.max(max, m.matchNo), 0) + 1;
  // 참가자 본인 연결·연결 링크·참가자 요청(migrations/0019)은 백업에 없고 복원이 지우지 않는다.
  // 복원한 기록에 그 참가자(정정 요청이면 그 경기)가 남아 있으면 그대로 두고, 없어졌으면 지운다.
  const cleanupMembers = [
    env.DB.prepare(
      `DELETE FROM participant_links WHERE group_id = ?1
         AND participant_id NOT IN (SELECT id FROM participants WHERE group_id = ?1)`,
    ).bind(groupId),
    env.DB.prepare(
      `DELETE FROM participant_claims WHERE group_id = ?1
         AND participant_id NOT IN (SELECT id FROM participants WHERE group_id = ?1)`,
    ).bind(groupId),
    env.DB.prepare(
      `DELETE FROM participant_requests WHERE group_id = ?1
         AND (participant_id NOT IN (SELECT id FROM participants WHERE group_id = ?1)
           OR (match_id IS NOT NULL AND match_id NOT IN (SELECT id FROM matches WHERE group_id = ?1)))`,
    ).bind(groupId),
  ];
  const finish = [
    ...cleanupMembers,
    env.DB.prepare(
      `UPDATE groups SET name = ?2, timezone = ?3, settings_version_id = ?4, next_match_no = ?5,
         live_version = live_version + 1, generation = generation + 1, maintenance = 0
       WHERE id = ?1`,
    ).bind(groupId, data.group.name, data.group.timezone, map(data.currentSettingsVersionId), nextMatchNo),
    env.DB.prepare("DELETE FROM restore_jobs WHERE group_id = ?1").bind(groupId),
  ];
  const stored = { groupId, ...countsOf(data) };

  const total = inserts.reduce((sum, s) => sum + s.bytes, 0);
  const limit = batchBytesOf(env);
  if (total <= limit) {
    // 한 batch = 한 트랜잭션. 점검 상태로 바꿀 필요 없이 통째로 바뀌거나 아무것도 안 바뀐다.
    // 잠금도 같은 batch 안에서 잡고(claim) 마지막에 지운다(finish): 다른 실행의 여러 단계 복원이 진행 중이면 실패한다.
    return {
      stored,
      statements: [
        claim, owner, guard, ...(links?.statements ?? []), ...deletes, ...inserts.map((s) => s.statement), ...finish,
      ],
    };
  }
  // 여러 단계: 잠금 + 점검 상태로 바꾸고 지우기 → 넣기(크기별로 나눔) → 점검 해제.
  // 모든 단계의 맨 앞은 주인 확인(owner)이다. 이 실행이 이어받힌 뒤에는 늦은 단계가 아무것도 넣지 못한다.
  const stages: D1PreparedStatement[][] = [
    [
      claim,
      owner,
      guard,
      env.DB.prepare("UPDATE groups SET maintenance = 1 WHERE id = ?1").bind(groupId),
      // 연결 되돌리기는 읽은 연결 상태와 함께 첫 단계에서 끝낸다. 중간에 끊겨 다시 실행하면 그때의 합치기 기록(지워졌거나
      // 파일 것)에는 되돌릴 것이 없어 다시 하지 않는다.
      ...(links?.statements ?? []),
      ...deletes,
    ],
  ];
  const heartbeat = jobHeartbeat(env, groupId, runToken);
  let current: D1PreparedStatement[] = [owner, heartbeat];
  let size = 0;
  for (const s of inserts) {
    if (size > 0 && size + s.bytes > limit) {
      stages.push(current);
      current = [owner, heartbeat];
      size = 0;
    }
    current.push(s.statement);
    size += s.bytes;
  }
  return { stored, stages, statements: [...current, ...finish], release: [jobRelease(env, groupId, runToken)] };
}

function parseApplyBody(body: Body): { requestId: string; backup: unknown } {
  const requestId = requireRequestId(body);
  if (body.confirm !== RESTORE_CONFIRM_TEXT) {
    throw new ApiError(400, "CONFIRM_REQUIRED", `확인 문구 '${RESTORE_CONFIRM_TEXT}'를 입력해 주세요.`);
  }
  return { requestId, backup: body.backup };
}

/** 같은 모임 복구. 파일의 모임 ID가 이 모임과 같아야 한다. */
export async function applyRestore(
  env: Env,
  groupId: string,
  req: Request,
  actor: BulkActor,
  /** 본문의 password로 지금 비밀번호를 확인한다(routeKit.ts confirmIdentity). 틀리면 던진다. */
  confirmPassword: (password: unknown) => Promise<void>,
): Promise<Record<string, unknown>> {
  // 요청 해시는 원문으로 계산한다(runMutation payloadText: 수 MB 백업을 다시 직렬화하지 않는다).
  const { body, text } = await readJsonBodyWithText(req, MAX_RESTORE_BODY_BYTES);
  assertOnlyKeys(body, ["requestId", "confirm", "baseGeneration", "backup", "password"]);
  await confirmPassword(body.password);
  const { requestId, backup } = parseApplyBody(body);
  const baseGeneration = requireInt(body.baseGeneration, "baseGeneration");
  const result = validateBackup(backup);
  if (!result.ok) throw invalid(result.problems);
  const data = result.data;
  if (data.group.id !== groupId) {
    throw new ApiError(
      409,
      "OTHER_GROUP_FILE",
      "다른 모임의 백업 파일입니다. 이 모임을 덮어쓰지 않습니다. 새 모임으로 가져오기를 써 주세요.",
    );
  }
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "restore",
    payload: { baseGeneration, backup },
    payloadText: text,
    allowMaintenance: () => canResumeRestore(env, groupId, requestId),
    onStageDone: (i) => restoreHooks.afterStage?.(i),
    conflictDetails: async () => ({
      generation: (
        await env.DB.prepare("SELECT generation FROM groups WHERE id = ?1").bind(groupId).first<{ generation: number }>()
      )?.generation,
    }),
    build: async () => {
      const clash = await foreignIdCollision(env, groupId, data);
      if (clash) throw invalid(["파일의 ID가 다른 모임의 기록과 겹칩니다."]);
      // 대량 쓰기 하루 예산(파일의 경기 수). 중간에 멈춘 같은 요청을 이어서 끝낼 때(작업 행이 이 요청의 것)는 다시 쓰지 않는다.
      const job = await readJob(env, groupId);
      if (job?.request_id !== requestId) await spendBulkRows(env, actor, data.matches.length);
      return buildRestorePlan(env, groupId, data, { remap: false, baseGeneration, requestId });
    },
  });
  return stored;
}

/**
 * 새 모임으로 가져오기(빈 환경 포함). 모든 ID를 새로 만든다.
 * 모임 ID는 (계정, 요청 ID)에서 정해지므로 같은 요청을 다시 보내면 같은 모임으로 이어진다.
 */
export async function importAsNewGroup(
  env: Env,
  accountId: string,
  req: Request,
  ip: string,
): Promise<Record<string, unknown>> {
  const { body, text } = await readJsonBodyWithText(req, MAX_RESTORE_BODY_BYTES);
  assertOnlyKeys(body, ["requestId", "confirm", "backup"]);
  const { requestId, backup } = parseApplyBody(body);
  const result = validateBackup(backup);
  if (!result.ok) throw invalid(result.problems);
  const data = result.data;

  const hex = await sha256Hex(`import-group\n${accountId}\n${requestId}`);
  const groupId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const existing = await env.DB.prepare(
    "SELECT account_id FROM group_operators WHERE group_id = ?1",
  )
    .bind(groupId)
    .first<{ account_id: string }>();
  if (existing && existing.account_id !== accountId) {
    throw new ApiError(404, "NOT_FOUND", "모임을 찾을 수 없습니다.");
  }
  if (existing) {
    // 이미 있는 모임: 끝나지 않은 가져오기(작업 행이 남음)를 이어서 끝내거나, 끝난 요청의 재전송(요청 기록)이다.
    // 둘 다 아니면 요청 기록이 보관 기간(14일) 뒤 지워진 것이다. 그 사이 쓴 기록을 파일로 덮어쓰지 않게 거절한다.
    const [job, record] = await Promise.all([
      readJob(env, groupId),
      env.DB.prepare("SELECT 1 AS ok FROM requests WHERE group_id = ?1 AND request_id = ?2")
        .bind(groupId, requestId)
        .first<{ ok: number }>(),
    ]);
    // 작업 행은 이 요청이 남긴 것(또는 0008 이전 버전이 남긴 주인 표시 없는 행)이어야 이어서 끝낼 수 있다.
    const ownJob = job !== null && (job.request_id === null || job.request_id === requestId);
    if (!ownJob && !record) {
      throw new ApiError(
        409,
        "REQUEST_EXPIRED",
        "이 가져오기는 이미 끝났고 요청 기록 보관 기간이 지났습니다. 그 모임을 덮어쓰지 않았습니다. 새로 가져오려면 파일을 다시 골라 주세요.",
        { groupId },
      );
    }
  }
  if (!existing) {
    // 계정당 모임 수(대표 + 공동 운영 합계) 한도. src/server/groups.ts
    if ((await accountGroupCount(env, accountId)) >= MAX_GROUPS_PER_ACCOUNT) throw tooManyGroupsError();
    // 대량 쓰기 하루 예산(파일의 경기 수). 모임을 처음 만들 때 한 번만 쓴다(이어서 끝내기·재전송은 위 existing 경로).
    await spendBulkRows(env, { accountId, ip }, data.matches.length);
    const now = nowIso();
    // 빈 모임을 점검 상태로 먼저 만든다. 가져오기가 끝나야 점검이 풀린다.
    // 첫 문장: 확인과 만들기 사이에 같은 계정의 다른 요청이 끼어 한도를 넘으면 막는다(migrations/0021).
    await env.DB.batch([
      groupLimitGuard(env, accountId),
      env.DB.prepare(
        `INSERT INTO groups (id, name, view_token, maintenance, created_at) VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT (id) DO NOTHING`,
      ).bind(groupId, data.group.name, newViewToken(), now),
      env.DB.prepare(
        `INSERT INTO group_operators (group_id, account_id, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (group_id) DO NOTHING`,
      ).bind(groupId, accountId, now),
      // 주인 없는 작업 행: 바로 뒤의 runMutation(또는 같은 요청의 재전송)이 잠금을 잡는다.
      env.DB.prepare(
        `INSERT INTO restore_jobs (group_id, started_at, request_id) VALUES (?1, ?2, ?3)
         ON CONFLICT (group_id) DO NOTHING`,
      ).bind(groupId, now, requestId),
    ]).catch((error: unknown) => {
      throw isGroupLimitError(error) ? tooManyGroupsError() : error;
    });
  }
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "restore-new-group",
    payload: { backup },
    payloadText: text,
    allowMaintenance: () => canResumeRestore(env, groupId, requestId),
    onStageDone: (i) => restoreHooks.afterStage?.(i),
    build: async () => {
      const generation = await env.DB.prepare("SELECT generation FROM groups WHERE id = ?1")
        .bind(groupId)
        .first<{ generation: number }>();
      return buildRestorePlan(env, groupId, data, {
        remap: true,
        baseGeneration: generation?.generation ?? 0,
        requestId,
      });
    },
  });
  return stored;
}
