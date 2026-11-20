/**
 * 진행 흐름을 거치지 않고 확정 경기를 만드는 쓰기 요청: 지난 경기 한 건 입력, 시트·기존 사이트 기록 한꺼번에 넣기,
 * 가져온 묶음 단위의 전적 제외·복구. 모임 탭의 가져오기 화면들이 부른다(경로는 index.ts).
 * 같은 경기가 두 번 세지지 않게 지문(fingerprint)으로 중복을 거른다. 검사와 가드는 matchChecks.ts에 있다.
 */
import { FUTURE_TOLERANCE_MS } from "../shared/backfill";
import { LEGACY_SOURCE_KEY, parseLegacyChoice, type LegacyChoice } from "../shared/legacy";
import {
  SIDES,
  TEAMS,
  teamASideFromWinner,
  type MatchView,
  type RosterEntry,
  type Side,
  type Team,
} from "../shared/types";
import type { Env } from "./env";
import {
  ApiError,
  assertOnlyKeys,
  newId,
  nowIso,
  requireIsoTime,
  requireOneOf,
  requireRequestId,
  requireString,
} from "./http";
import { insertRevision, runMutation, type Plan } from "./mutation";
import { spendBulkRows, type BulkActor } from "./ratelimit";
import { seriesBatchRestoreGuards } from "./series";
import {
  assertActiveParticipants,
  fingerprintOverlaps,
  fingerprintScopeGuard,
  fingerprintScopeStamp,
  insertRoster,
  overlapText,
  parseRoster,
  storedFingerprintRestoreGuard,
  type Body,
} from "./matchChecks";
import { groupFingerprints } from "./sheets";
import { loadMatch } from "./snapshot";

/* ------------------------------------------------------------------ */
/* 지난 경기 입력                                                       */
/* ------------------------------------------------------------------ */

/**
 * 초안·진행 중을 거치지 않고 결과 확정 경기를 직접 만든다.
 * 세션·현재 경기·순환·진행 상태 버전을 건드리지 않는다.
 */
export async function backfillMatch(env: Env, groupId: string, body: Body, actor: BulkActor): Promise<MatchView> {
  assertOnlyKeys(body, ["requestId", "playedAt", "roster", "winnerTeam", "winnerSide"]);
  const requestId = requireRequestId(body);
  const playedAt = requireIsoTime(body.playedAt, "playedAt");
  // 일괄 입력(importMatches)과 같은 기준: 화면 검사(backfillProblems)를 거치지 않은 요청도 미래 경기는 거절한다.
  if (Date.parse(playedAt) > Date.now() + FUTURE_TOLERANCE_MS) {
    throw new ApiError(400, "FUTURE_MATCH", "아직 오지 않은 시각의 경기는 넣을 수 없습니다. 날짜와 시각을 확인해 주세요.");
  }
  const roster = parseRoster(body.roster, false);
  const winnerTeam = requireOneOf<Team>(body.winnerTeam, TEAMS, "winnerTeam");
  const winnerSide = requireOneOf<Side>(body.winnerSide, SIDES, "winnerSide");
  const teamASide = teamASideFromWinner(winnerTeam, winnerSide);
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "backfill",
    payload: { playedAt, roster, winnerTeam, winnerSide },
    build: async () => {
      await assertActiveParticipants(
        env,
        groupId,
        roster.map((r) => r.participantId),
      );
      // 대량 쓰기 하루 예산(1경기). 검증이 끝난 뒤에만 쓰고, 같은 요청 ID의 재시도(재생)는 여기까지 오지 않는다.
      await spendBulkRows(env, actor, 1);
      const now = nowIso();
      const matchId = newId();
      return {
        stored: { matchId },
        statements: [
          env.DB.prepare(
            `INSERT INTO matches (id, group_id, match_no, state, source, played_at, ended_at,
               confirmed_at, winner_team, team_a_side, settings_version_id)
             SELECT ?1, id, next_match_no, 'confirmed', 'backfill', ?3, ?3, ?4, ?5, ?6, settings_version_id
             FROM groups WHERE id = ?2`,
          ).bind(matchId, groupId, playedAt, now, winnerTeam, teamASide),
          env.DB.prepare("UPDATE groups SET next_match_no = next_match_no + 1 WHERE id = ?1").bind(
            groupId,
          ),
          ...insertRoster(env, groupId, matchId, roster),
          insertRevision(
            env,
            groupId,
            matchId,
            "backfill",
            {
              winnerTeam: { from: null, to: winnerTeam },
              teamASide: { from: null, to: teamASide },
            },
            now,
          ),
        ],
      };
    },
  });
  return loadMatch(env, groupId, stored.matchId as string);
}

/* ------------------------------------------------------------------ */
/* 지난 기록 한꺼번에 넣기                                              */
/* ------------------------------------------------------------------ */

export const MAX_IMPORT_MATCHES = 50;
export const MAX_IMPORT_BODY_BYTES = 256 * 1024;

interface ImportMatch {
  playedAt: string;
  roster: RosterEntry[];
  winnerTeam: Team;
  winnerSide: Side;
  /** 다시 가져오기 중복 방지용 시트 내용 지문과 줄 위치 열쇠(src/shared/sheetFingerprint.ts·sheetTable.ts). 없어도 된다. */
  fingerprint?: string;
  rowKey?: string;
}

/** 일괄 입력 묶음의 출처(migrations/0007, 0010). 없으면 기록하지 않는다(이전 화면과 호환). */
interface ImportSource {
  kind: "paste" | "sheet" | "legacy";
  sourceKey: string | null;
  label: string | null;
  /** 기존 사이트 가져오기에서 고른 날짜 처리(migrations/0010). 그 밖에는 null. */
  options: LegacyChoice | null;
}

const FINGERPRINT = /^v1-[0-9a-f]{16}$/;
/** 줄 위치 열쇠: 시트 "날짜#같은 날 순서", 기존 사이트 "v1id:{경기 id 해시}"(src/shared/legacy.ts). */
const ROW_KEY = /^(\d{4}-\d{2}-\d{2}#\d{1,5}|v1id:[0-9a-f]{16})$/;
const SOURCE_KEY = /^(sheet|pub):[A-Za-z0-9_-]{20,220}:(\d{1,12}|first)$/;

function parseImportSource(value: unknown): ImportSource | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_FIELD", "source 값이 올바르지 않습니다.");
  }
  const raw = value as Body;
  assertOnlyKeys(raw, ["kind", "sourceKey", "label", "options"]);
  const kind = requireOneOf<"paste" | "sheet" | "legacy">(raw.kind, ["paste", "sheet", "legacy"], "source.kind");
  let sourceKey: string | null = null;
  let options: LegacyChoice | null = null;
  if (kind === "sheet" || kind === "legacy") {
    sourceKey = requireString(raw.sourceKey, "source.sourceKey", 1, 260);
    if (!(kind === "sheet" ? SOURCE_KEY : LEGACY_SOURCE_KEY).test(sourceKey)) {
      throw new ApiError(400, "INVALID_FIELD", "source.sourceKey 값이 올바르지 않습니다.");
    }
  } else if (raw.sourceKey !== undefined && raw.sourceKey !== null) {
    throw new ApiError(400, "INVALID_FIELD", "source.sourceKey 값이 올바르지 않습니다.");
  }
  let label: string | null = null;
  if (raw.label !== undefined && raw.label !== null) {
    // eslint-disable-next-line no-control-regex -- 제어 문자를 일부러 찾아 공백으로 바꾼다.
    label = requireString(raw.label, "source.label", 1, 100).replace(/[\u0000-\u001f\u007f]/g, " ").trim() || null;
  }
  if (raw.options !== undefined && raw.options !== null) {
    options = kind === "legacy" ? parseLegacyChoice(raw.options) : null;
    if (options === null) throw new ApiError(400, "INVALID_FIELD", "source.options 값이 올바르지 않습니다.");
  }
  return { kind, sourceKey, label, options };
}

/**
 * 결과가 이미 정해진 지난 경기를 한 번에 여러 개 넣는다(시트에 기록해 둔 모임용).
 * 받은 묶음 전체를 먼저 검증하고, 하나라도 틀리면 아무것도 저장하지 않는다.
 * 한 묶음은 한 batch로 저장하므로 일부만 들어가는 일이 없다.
 * 세션·현재 경기·순환·진행 상태 버전은 건드리지 않는다.
 * 진영은 요청이 정한 값을 그대로 쓴다(미상으로 넣을지 그대로 넣을지는 사용자가 고른다).
 */
export async function importMatches(
  env: Env,
  groupId: string,
  body: Body,
  actor: BulkActor,
): Promise<{ matchIds: string[] }> {
  assertOnlyKeys(body, ["requestId", "batchId", "matches", "source"]);
  const requestId = requireRequestId(body);
  // 한 번의 일괄 입력을 여러 묶음으로 나눠 보내도 같은 batchId를 쓴다. 되돌릴 때 이 값으로 찾는다.
  const batchId = requireString(body.batchId, "batchId", 8, 64);
  const source = parseImportSource(body.source);
  if (
    !Array.isArray(body.matches) ||
    body.matches.length < 1 ||
    body.matches.length > MAX_IMPORT_MATCHES
  ) {
    throw new ApiError(
      400,
      "INVALID_FIELD",
      `한 번에 1~${MAX_IMPORT_MATCHES}경기까지 넣을 수 있습니다.`,
    );
  }
  const matches: ImportMatch[] = body.matches.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ApiError(400, "INVALID_FIELD", "경기 형식이 올바르지 않습니다.", { index });
    }
    const entry = raw as Body;
    try {
      assertOnlyKeys(entry, ["playedAt", "roster", "winnerTeam", "winnerSide", "fingerprint", "rowKey"]);
      const match: ImportMatch = {
        playedAt: requireIsoTime(entry.playedAt, "playedAt"),
        roster: parseRoster(entry.roster, false),
        winnerTeam: requireOneOf<Team>(entry.winnerTeam, TEAMS, "winnerTeam"),
        winnerSide: requireOneOf<Side>(entry.winnerSide, SIDES, "winnerSide"),
      };
      // 지난 경기만 넣는다. 시계 오차는 지난 경기 한 건 입력 화면과 같은 폭만 봐준다.
      if (Date.parse(match.playedAt) > Date.now() + FUTURE_TOLERANCE_MS) {
        throw new ApiError(400, "FUTURE_MATCH", "아직 오지 않은 시각의 경기는 넣을 수 없습니다. 날짜를 확인해 주세요.");
      }
      // 지문이 없는 요청(이전 화면)은 요청 내용이 예전과 똑같이 해시되도록 키를 만들지 않는다.
      if (entry.fingerprint !== undefined) {
        const fingerprint = requireString(entry.fingerprint, "fingerprint", 1, 40);
        if (!FINGERPRINT.test(fingerprint)) throw new ApiError(400, "INVALID_FIELD", "fingerprint 값이 올바르지 않습니다.");
        match.fingerprint = fingerprint;
      }
      if (entry.rowKey !== undefined) {
        const rowKey = requireString(entry.rowKey, "rowKey", 1, 40);
        if (!ROW_KEY.test(rowKey) || match.fingerprint === undefined) {
          throw new ApiError(400, "INVALID_FIELD", "rowKey 값이 올바르지 않습니다.");
        }
        match.rowKey = rowKey;
      }
      return match;
    } catch (error) {
      // 몇 번째 경기에서 틀렸는지 알려준다.
      if (error instanceof ApiError) {
        throw new ApiError(400, error.code, error.message, { index });
      }
      throw error;
    }
  });

  const fingerprints = matches.map((m) => m.fingerprint).filter((f): f is string => f !== undefined);
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new ApiError(400, "INVALID_FIELD", "같은 지문의 경기가 두 번 들어 있습니다.");
  }

  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "import",
    // 출처가 없는 요청은 예전과 같은 내용으로 해시한다(이어서 넣기 호환).
    // 날짜 처리 선택이 없는 출처는 이전과 같은 내용으로 해시한다(이어서 넣기 호환).
    payload:
      source === undefined
        ? { batchId, matches }
        : {
            batchId,
            matches,
            source: source.options === null ? { kind: source.kind, sourceKey: source.sourceKey, label: source.label } : source,
          },
    build: async () => {
      // 다시 가져오기 중복 방지: 같은 지문의 경기가 전적 제외가 아닌 상태로 이미 있으면 거절한다.
      // 지운 경기는 견주지 않는다(groupFingerprints가 뺀다): 잘못 넣은 것을 지우고 고쳐서 다시 넣는 흐름을 막지 않는다.
      // 지문 없는 예전 일괄 입력·지난 경기 입력은 내용으로 계산한 지문과 견준다(화면의 비교와 같은 기준).
      let scopeStamp: string | null = null;
      if (fingerprints.length > 0) {
        scopeStamp = await fingerprintScopeStamp(env, groupId);
        const wanted = new Set(fingerprints);
        const found = new Set(
          (await groupFingerprints(env, groupId))
            .filter((f) => f.state !== "excluded" && wanted.has(f.fingerprint))
            .map((f) => f.fingerprint),
        );
        if (found.size > 0) {
          throw new ApiError(
            409,
            "ALREADY_IMPORTED",
            "이미 들어간 경기가 섞여 있어요. 화면을 새로 고친 뒤 다시 확인해 주세요.",
            { indexes: matches.flatMap((m, i) => (m.fingerprint && found.has(m.fingerprint) ? [i] : [])) },
          );
        }
      }
      const active = await env.DB.prepare(
        "SELECT id FROM participants WHERE group_id = ?1 AND status = 'active'",
      )
        .bind(groupId)
        .all<{ id: string }>();
      const activeIds = new Set(active.results.map((r) => r.id));
      matches.forEach((match, index) => {
        const missing = match.roster.map((r) => r.participantId).filter((id) => !activeIds.has(id));
        if (missing.length > 0) {
          throw new ApiError(
            400,
            "INVALID_PARTICIPANT",
            "이 모임의 참가자가 아닌 사람이 있습니다.",
            { index, participantIds: missing },
          );
        }
      });

      // 대량 쓰기 하루 예산(이 묶음의 경기 수). 검증이 모두 끝난 뒤, 쓰기 직전에 쓴다.
      await spendBulkRows(env, actor, matches.length);
      const now = nowIso();
      const statements: D1PreparedStatement[] = [];
      if (scopeStamp !== null) {
        // 확인과 저장 사이에 다른 탭이 같은 경기를 넣었으면 batch 전체를 실패시킨다.
        statements.push(fingerprintScopeGuard(env, groupId, scopeStamp));
        statements.push(
          env.DB.prepare(
            `INSERT INTO guard (version_conflict)
             SELECT 1 WHERE EXISTS (
               SELECT 1 FROM matches WHERE group_id = ?1 AND state <> 'excluded' AND deleted_at IS NULL
                 AND import_fingerprint IN (SELECT value FROM json_each(?2))
             )`,
          ).bind(groupId, JSON.stringify(fingerprints)),
        );
      }
      if (source !== undefined) {
        // 여러 묶음으로 나눠 보내도 출처 행은 첫 묶음에서 한 번만 생긴다.
        statements.push(
          env.DB.prepare(
            `INSERT INTO import_batches (group_id, id, kind, source_key, label, created_at, options)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (group_id, id) DO NOTHING`,
          ).bind(
            groupId,
            batchId,
            source.kind,
            source.sourceKey,
            source.label,
            now,
            source.options === null ? null : JSON.stringify(source.options),
          ),
        );
      }
      const matchIds: string[] = [];
      matches.forEach((match, offset) => {
        const matchId = newId();
        matchIds.push(matchId);
        const teamASide = teamASideFromWinner(match.winnerTeam, match.winnerSide);
        statements.push(
          match.fingerprint === undefined
            ? env.DB.prepare(
                `INSERT INTO matches (id, group_id, match_no, state, source, played_at, ended_at,
                   confirmed_at, winner_team, team_a_side, settings_version_id, import_batch_id)
                 SELECT ?1, id, next_match_no + ?7, 'confirmed', 'import', ?3, ?3, ?4, ?5, ?6,
                   settings_version_id, ?8
                 FROM groups WHERE id = ?2`,
              ).bind(
                matchId,
                groupId,
                match.playedAt,
                now,
                match.winnerTeam,
                teamASide,
                offset,
                batchId,
              )
            : env.DB.prepare(
                `INSERT INTO matches (id, group_id, match_no, state, source, played_at, ended_at,
                   confirmed_at, winner_team, team_a_side, settings_version_id, import_batch_id,
                   import_fingerprint, import_row_key)
                 SELECT ?1, id, next_match_no + ?7, 'confirmed', 'import', ?3, ?3, ?4, ?5, ?6,
                   settings_version_id, ?8, ?9, ?10
                 FROM groups WHERE id = ?2`,
              ).bind(
                matchId,
                groupId,
                match.playedAt,
                now,
                match.winnerTeam,
                teamASide,
                offset,
                batchId,
                match.fingerprint,
                match.rowKey ?? null,
              ),
        );
        // 명단 10행을 한 문장으로 넣는다(문장당 값 50개).
        const values = match.roster.map(() => "(?, ?, ?, ?, ?)").join(", ");
        statements.push(
          env.DB.prepare(
            `INSERT INTO match_roster (match_id, group_id, participant_id, team, position)
             VALUES ${values}`,
          ).bind(
            ...match.roster.flatMap((r) => [matchId, groupId, r.participantId, r.team, r.position]),
          ),
        );
        statements.push(
          insertRevision(
            env,
            groupId,
            matchId,
            "backfill",
            {
              winnerTeam: { from: null, to: match.winnerTeam },
              teamASide: { from: null, to: teamASide },
            },
            now,
          ),
        );
      });
      statements.push(
        env.DB.prepare("UPDATE groups SET next_match_no = next_match_no + ?1 WHERE id = ?2").bind(
          matches.length,
          groupId,
        ),
      );
      return { stored: { matchIds }, statements };
    },
  });
  return { matchIds: stored.matchIds as string[] };
}

/**
 * 일괄 입력 한 번(묶음)으로 넣은 경기를 모두 전적 제외하거나 다시 복구한다.
 * 경기마다 하나씩 제외하는 것과 같은 결과이며 변경 이력도 경기마다 남는다.
 * 그 묶음의 경기 중 손으로 따로 제외·정정한 경기도 상태 기준으로만 처리한다:
 * 제외는 "결과 확정" 경기에만, 복구는 "확정이었다가 제외된" 경기에만 적용된다.
 */
export async function setImportBatchExcluded(
  env: Env,
  groupId: string,
  batchId: string,
  body: Body,
): Promise<{ changed: number; skipped?: number }> {
  assertOnlyKeys(body, ["requestId", "exclude", "skipOverlapping"]);
  const requestId = requireRequestId(body);
  if (typeof body.exclude !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "exclude 값이 올바르지 않습니다.");
  }
  if (body.skipOverlapping !== undefined && typeof body.skipOverlapping !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "skipOverlapping 값이 올바르지 않습니다.");
  }
  const exclude = body.exclude;
  const skipOverlapping = !exclude && body.skipOverlapping === true;
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "import-batch",
    // 예전 요청과 같은 내용으로 해시되도록 기본값은 넣지 않는다.
    payload: skipOverlapping ? { batchId, exclude, skipOverlapping } : { batchId, exclude },
    build: async () => {
      if (!exclude) return restoreImportBatch(env, groupId, batchId, skipOverlapping);
      const target = await env.DB.prepare(
        exclude
          ? `SELECT COUNT(*) AS n FROM matches
             WHERE group_id = ?1 AND import_batch_id = ?2 AND state = 'confirmed' AND deleted_at IS NULL`
          : `SELECT COUNT(*) AS n FROM matches
             WHERE group_id = ?1 AND import_batch_id = ?2 AND state = 'excluded'
               AND prev_state = 'confirmed' AND deleted_at IS NULL`,
      )
        .bind(groupId, batchId)
        .first<{ n: number }>();
      const exists = await env.DB.prepare(
        "SELECT 1 AS ok FROM matches WHERE group_id = ?1 AND import_batch_id = ?2 LIMIT 1",
      )
        .bind(groupId, batchId)
        .first<{ ok: number }>();
      if (!exists) throw new ApiError(404, "NOT_FOUND", "일괄 입력 기록을 찾을 수 없습니다.");
      const now = nowIso();
      const from = exclude ? "confirmed" : "excluded";
      const to = exclude ? "excluded" : "confirmed";
      // 지운 경기는 묶음 제외·복구에서도 건드리지 않는다(되살렸을 때 지우기 전 상태 그대로여야 한다).
      const where = exclude
        ? "group_id = ?1 AND import_batch_id = ?2 AND state = 'confirmed' AND deleted_at IS NULL"
        : "group_id = ?1 AND import_batch_id = ?2 AND state = 'excluded' AND prev_state = 'confirmed' AND deleted_at IS NULL";
      return {
        stored: { changed: target?.n ?? 0 },
        statements: [
          // 이력을 먼저 남긴다(상태를 바꾸기 전의 대상 경기를 기준으로).
          env.DB.prepare(
            `INSERT INTO match_revisions (group_id, match_id, kind, changes, created_at)
             SELECT group_id, id, ?3, ?4, ?5 FROM matches WHERE ${where}`,
          ).bind(
            groupId,
            batchId,
            exclude ? "exclude" : "restore",
            JSON.stringify({ state: { from, to } }),
            now,
          ),
          env.DB.prepare(
            exclude
              ? `UPDATE matches SET state = 'excluded', prev_state = 'confirmed', version = version + 1
                 WHERE ${where}`
              : `UPDATE matches SET state = 'confirmed', prev_state = NULL, version = version + 1
                 WHERE ${where}`,
          ).bind(groupId, batchId),
        ],
      };
    },
  });
  return stored.skipped === undefined
    ? { changed: stored.changed as number }
    : { changed: stored.changed as number, skipped: stored.skipped as number };
}

/**
 * 묶음 복구. 복구할 경기 중 같은 내용(지문)의 경기가 이미 기록에 있으면(제외한 뒤 같은 시트를 다시 가져온 경우 등)
 * 기본으로 전체를 거절하고 어떤 경기끼리 겹치는지 알려 준다. 사용자가 고르면(skipOverlapping) 겹치지 않는 경기만 복구한다.
 * 겹치는 경기를 말없이 빼면 "모두 복구"를 눌렀는데 일부만 돌아와 헷갈리므로, 먼저 알리고 고르게 한다.
 */
async function restoreImportBatch(env: Env, groupId: string, batchId: string, skipOverlapping: boolean): Promise<Plan> {
  const exists = await env.DB.prepare("SELECT 1 AS ok FROM matches WHERE group_id = ?1 AND import_batch_id = ?2 LIMIT 1")
    .bind(groupId, batchId)
    .first<{ ok: number }>();
  if (!exists) throw new ApiError(404, "NOT_FOUND", "일괄 입력 기록을 찾을 수 없습니다.");
  const stamp = await fingerprintScopeStamp(env, groupId);
  const targets = await env.DB.prepare(
    `SELECT id FROM matches
     WHERE group_id = ?1 AND import_batch_id = ?2 AND state = 'excluded' AND prev_state = 'confirmed'
       AND deleted_at IS NULL`,
  )
    .bind(groupId, batchId)
    .all<{ id: string }>();
  const ids = targets.results.map((r) => r.id);
  const overlaps = await fingerprintOverlaps(env, groupId, ids);
  if (overlaps.length > 0 && !skipOverlapping) {
    throw new ApiError(
      409,
      "RESTORE_DUPLICATE",
      `이 묶음의 ${overlaps.length}경기는 같은 내용의 경기가 이미 기록에 있어요(${overlapText(overlaps)}). 두 번 세지 않도록 복구하지 않았어요.`,
      {
        overlaps: overlaps.map((o) => ({ matchNo: o.matchNo, with: o.with })),
        restorable: ids.length - overlaps.length,
      },
    );
  }
  const skip = new Set(overlaps.map((o) => o.matchId));
  const restore = ids.filter((id) => !skip.has(id));
  // 시리즈: 한 경기 복구(restoreMatch)와 같은 기준. 제외한 사이 판을 더 넣어 승부가 났으면 거절한다.
  const seriesGuards = await seriesBatchRestoreGuards(env, groupId, restore);
  const now = nowIso();
  const where = `group_id = ?1 AND id IN (SELECT value FROM json_each(?2)) AND state = 'excluded' AND prev_state = 'confirmed'
    AND deleted_at IS NULL`;
  const list = JSON.stringify(restore);
  return {
    stored: { changed: restore.length, ...(skipOverlapping ? { skipped: overlaps.length } : {}) },
    statements: [
      // 확인 뒤 범위가 바뀌었거나(다른 탭의 가져오기·복구) 고른 경기가 이미 바뀌었으면 batch 전체를 실패시킨다.
      fingerprintScopeGuard(env, groupId, stamp),
      storedFingerprintRestoreGuard(env, groupId, restore),
      ...seriesGuards,
      env.DB.prepare(
        `INSERT INTO guard (version_conflict)
         SELECT 1 WHERE (SELECT COUNT(*) FROM matches WHERE ${where}) <> ?3`,
      ).bind(groupId, list, restore.length),
      env.DB.prepare(
        `INSERT INTO match_revisions (group_id, match_id, kind, changes, created_at)
         SELECT group_id, id, 'restore', ?3, ?4 FROM matches WHERE ${where}`,
      ).bind(groupId, list, JSON.stringify({ state: { from: "excluded", to: "confirmed" } }), now),
      env.DB.prepare(
        `UPDATE matches SET state = 'confirmed', prev_state = NULL, version = version + 1 WHERE ${where}`,
      ).bind(groupId, list),
    ],
  };
}
