// 운영자용 백업 파일 만들기(모임 탭 '백업 내려받기', 자동 백업 backupCron.ts). 읽는 쪽은 restoreChecks.ts·restore.ts다.
import { parseLegacyChoice, type LegacyChoice } from "../shared/legacy";
import type { Env } from "./env";
import { nowIso } from "./http";
import { parseSnapshot, snapshotStatements } from "./snapshot";

/**
 * 1: 첫 형식. 2: 복원용 값 추가. 3: 중복 참가자 합치기 기록(participantMerges) 추가.
 * 4: 일괄 입력 출처(importBatches)와 경기의 가져오기 지문(importFingerprint, importRowKey) 추가.
 * src/server/restoreChecks.ts가 1~4를 모두 읽는다.
 * 형식 번호를 올리지 않고 더한 항목(없는 예전 백업도 복원된다): 서포터 횟수 보정값(supportAdjustments),
 * 기피 라인(참가자 avoidPositions), 경기 메모(경기 memo), 시리즈 묶음(series), 경기 삭제 시각(경기 deletedAt, migrations/0026),
 * 티어 5단계(참가자 skillGroup 5, 설정 groupWeights 5개 — 4개짜리 예전 백업은 parseSettings가 5개로 맞춘다).
 */
export const BACKUP_FORMAT_VERSION = 4;

/**
 * 운영자용 백업(docs/P4 P4-3).
 * 계정, 운영자 권한, 조회 토큰, 세션, 요청 기록은 들어가지 않는다.
 */
export async function exportBackup(env: Env, groupId: string): Promise<Record<string, unknown>> {
  // 스냅숏 읽기와 백업 전용 읽기를 D1 batch 한 번(한 트랜잭션, 왕복 1회)으로 한다(2026-11-08).
  // 예전에는 스냅숏 batch 뒤에 10번을 따로 읽어, 사이에 저장이 끼면 경기와 이력·명단이 서로 다른 시점일 수 있었다.
  // 문장과 정렬은 예전과 같아 백업 파일 내용(키 순서 포함)은 그대로다.
  // 지운 경기도 넣는다(withDeleted): 이력·명단·시리즈 소속이 그 경기를 가리키고, 복원한 뒤에도 지운 채로 남아야 한다.
  const base = snapshotStatements(env, groupId, "operator", true);
  const q = (sql: string) => env.DB.prepare(sql).bind(groupId);
  const results = await env.DB.batch([
    ...base,
    q("SELECT id, version_no, payload, created_at FROM settings_versions WHERE group_id = ?1 ORDER BY version_no"),
    q("SELECT id, started_at, last_activity_at, closed_at FROM sessions WHERE group_id = ?1 ORDER BY started_at"),
    q("SELECT id, session_id, status, created_at, closed_at FROM rotation_cycles WHERE group_id = ?1 ORDER BY created_at"),
    q(
      `SELECT id, cycle_id, match_id, participant_id, kind, voided, created_at
       FROM rotation_events WHERE group_id = ?1 ORDER BY created_at, id`,
    ),
    q(
      `SELECT cycle_id, participant_id, delta, updated_at FROM support_adjustments
       WHERE group_id = ?1 ORDER BY updated_at, participant_id`,
    ),
    q("SELECT id, match_id, kind, changes, created_at FROM match_revisions WHERE group_id = ?1 ORDER BY id"),
    // 형식 2: 복원에 필요한 값(제외 직전 상태, 적용 설정 버전, 일괄 입력 묶음, 참가자 생성 시각)을 더한다.
    q(
      `SELECT id, prev_state, settings_version_id, import_batch_id, import_fingerprint, import_row_key
       FROM matches WHERE group_id = ?1`,
    ),
    // 형식 4: 일괄 입력 출처.
    q("SELECT id, kind, source_key, label, created_at, options FROM import_batches WHERE group_id = ?1 ORDER BY created_at, id"),
    q("SELECT id, created_at FROM participants WHERE group_id = ?1"),
    // 형식 3: 합치기 기록. 되돌리기에 필요한 옮긴 행 목록을 그대로 넣는다.
    // moved_link(migrations/0023)는 계정 ID라 넣지 않는다(연결은 백업 밖). 새 모임으로 가져온 합치기는 연결 기록 없음(NULL)이
    // 된다. 같은 모임 복구는 지금 DB에도 유효한 같은 합치기면 그 값을 그대로 이어 쓴다(restore.ts rewindMergeLinks).
    q(
      `SELECT id, source_id, target_id, source_prev_status, moved_matches, rotation_changes, created_at, undone_at
       FROM participant_merges WHERE group_id = ?1 ORDER BY created_at, id`,
    ),
  ]);
  const snapshot = parseSnapshot("operator", results);
  let i = base.length;
  const next = <T>(): { results: T[] } => ({ results: (results[i++]?.results ?? []) as unknown as T[] });
  const settingsVersions = next<{ id: string; version_no: number; payload: string; created_at: string }>();
  const sessions = next<Record<string, unknown>>();
  const cycles = next<Record<string, unknown>>();
  const events = next<Record<string, unknown>>();
  const adjustments = next<{ cycle_id: string | null; participant_id: string; delta: number; updated_at: string }>();
  const revisions = next<{ id: number; match_id: string; kind: string; changes: string; created_at: string }>();
  const matchExtras = next<{
    id: string;
    prev_state: string | null;
    settings_version_id: string | null;
    import_batch_id: string | null;
    import_fingerprint: string | null;
    import_row_key: string | null;
  }>();
  const importBatches = next<{
    id: string;
    kind: string;
    source_key: string | null;
    label: string | null;
    created_at: string;
    options: string | null;
  }>();
  const extraById = new Map(matchExtras.results.map((m) => [m.id, m]));
  const participantTimes = next<{ id: string; created_at: string }>();
  const createdById = new Map(participantTimes.results.map((p) => [p.id, p.created_at]));
  const merges = next<{
    id: string;
    source_id: string;
    target_id: string;
    source_prev_status: string;
    moved_matches: string;
    rotation_changes: string;
    created_at: string;
    undone_at: string | null;
  }>();
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: nowIso(),
    scope: "group",
    group: {
      id: snapshot.group.id,
      name: snapshot.group.name,
      timezone: snapshot.group.timezone,
      currentSettingsVersionId: snapshot.group.settingsVersionId ?? null,
    },
    matchCount: snapshot.matches.length,
    // 행 버전(version)은 이 서버 안의 동시 수정 확인용이라 백업에 넣지 않는다(복원하면 새로 0부터 센다).
    participants: snapshot.participants.map(({ version: _version, ...p }) => ({ ...p, createdAt: createdById.get(p.id) })),
    seasons: snapshot.seasons,
    // 시리즈 묶음(2026-11-06). 경기 메모는 경기 항목(memo)에 들어 있다. 둘 다 없는 예전 백업도 복원된다.
    series: snapshot.series ?? [],
    matches: snapshot.matches.map((m) => {
      const extra = extraById.get(m.id);
      return {
        ...m,
        prevState: extra?.prev_state ?? null,
        settingsVersionId: extra?.settings_version_id ?? null,
        importBatchId: extra?.import_batch_id ?? null,
        importFingerprint: extra?.import_fingerprint ?? null,
        importRowKey: extra?.import_row_key ?? null,
      };
    }),
    importBatches: importBatches.results.map((b) => ({
      id: b.id,
      kind: b.kind,
      sourceKey: b.source_key,
      label: b.label,
      createdAt: b.created_at,
      // 기존 사이트 가져오기의 날짜 처리 선택(migrations/0010). 그 밖에는 null.
      options: b.options === null ? null : parseStoredChoice(b.options),
    })),
    revisions: revisions.results.map((r) => ({
      id: r.id,
      matchId: r.match_id,
      kind: r.kind,
      changes: JSON.parse(r.changes) as unknown,
      createdAt: r.created_at,
    })),
    sessions: sessions.results,
    rotationCycles: cycles.results,
    rotationEvents: events.results,
    // 서포터 횟수 직접 입력의 보정값(2026-11-06). 이 항목이 없는 예전 백업도 복원된다.
    supportAdjustments: adjustments.results.map((a) => ({
      cycleId: a.cycle_id,
      participantId: a.participant_id,
      delta: a.delta,
      updatedAt: a.updated_at,
    })),
    settingsVersions: settingsVersions.results.map((s) => ({
      id: s.id,
      versionNo: s.version_no,
      settings: JSON.parse(s.payload) as unknown,
      createdAt: s.created_at,
    })),
    participantMerges: merges.results.map((m) => ({
      id: m.id,
      sourceId: m.source_id,
      targetId: m.target_id,
      sourcePrevStatus: m.source_prev_status,
      movedMatches: JSON.parse(m.moved_matches) as unknown,
      rotationChanges: JSON.parse(m.rotation_changes) as unknown,
      createdAt: m.created_at,
      undoneAt: m.undone_at,
    })),
  };
}

function parseStoredChoice(text: string): LegacyChoice | null {
  try {
    return parseLegacyChoice(JSON.parse(text));
  } catch {
    return null;
  }
}
