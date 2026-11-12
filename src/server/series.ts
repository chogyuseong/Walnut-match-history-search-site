/**
 * 시리즈 묶음(migrations/0017). 여러 경기를 한 시리즈(3판 2선승·5판 3선승·자유)로 묶는다.
 *
 * - 만드는 길 두 가지: ① 경기 시작 때 "시리즈로 이어가기"(startMatch의 series 선택 필드, seriesContinuePlan)
 *   ② 기록 화면·경기 상세에서 확정 경기로 새 시리즈를 만들거나(createSeries) 넣고 빼기(addToSeries, removeFromSeries).
 * - 두 팀의 5명 구성이 시리즈의 기준 판과 같아야 넣을 수 있다(src/shared/series.ts compositionKey·seriesReferenceOf:
 *   제외·취소가 아닌 판들 중 가장 많은 구성, 동률이면 이른 쪽. 2026-11-08 전에는 첫 판). 다르면 거절한다.
 * - 질의 수(무료 요금제: 호출당 50회): 판 수와 상관없이 몇 회로 끝난다(경기·명단은 json_each로 한 번에 읽는다).
 * - 같은 요청 ID의 재전송은 요청 기록에 남긴 시리즈를 그대로 돌려준다(storedSeries).
 * - 한 경기는 한 시리즈에만 들어간다(match_series_members 기본 키). 마지막 판을 빼면 시리즈도 지운다.
 * - 모임 경계: 경기·시리즈는 그 모임의 것만 찾는다(group_id 조건). 표의 복합 외래 키도 막는다.
 * - 경기 버전·진행 상태 버전은 올리지 않는다(시리즈는 기록을 묶어 보여 주는 것뿐이고 승패·명단은 그대로다).
 *   대신 확인한 때의 경기 버전·상태가 저장할 때도 같은지 보호 문장으로 확인한다(그 사이 참가자 교체 정정 등).
 */
import {
  compositionKey,
  SERIES_FORMAT_LABEL,
  SERIES_NAME_MAX,
  SERIES_TEAMS_DIFFER_TEXT,
  SERIES_WINS_NEEDED,
  seriesReferenceOf,
  seriesScore,
} from "../shared/series";
import { cleanName } from "../shared/names";
import { SERIES_FORMATS, type MatchView, type RosterEntry, type SeriesFormat, type SeriesView } from "../shared/types";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, newId, nowIso, requireOneOf, requireString } from "./http";
import { runMutation, type Plan } from "./mutation";
import { loadMatch, loadMatchesByIds, loadSeries } from "./snapshot";

type Body = Record<string, unknown>;

/** 한 시리즈에 넣을 수 있는 판 수 상한(자유 형식 포함). */
export const MAX_SERIES_GAMES = 15;

function parseName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 200) {
    throw new ApiError(400, "INVALID_FIELD", "name 값이 올바르지 않습니다.");
  }
  const name = cleanName(value);
  if (name === "") return null;
  if ([...name].length > SERIES_NAME_MAX) {
    throw new ApiError(400, "INVALID_FIELD", `시리즈 이름은 ${SERIES_NAME_MAX}자까지 쓸 수 있어요.`);
  }
  return name;
}

function parseFormat(value: unknown): SeriesFormat {
  return requireOneOf<SeriesFormat>(value, SERIES_FORMATS, "format");
}

function teamsDiffer(details?: unknown): ApiError {
  return new ApiError(409, "SERIES_TEAMS_DIFFER", SERIES_TEAMS_DIFFER_TEXT, details);
}

async function findSeries(env: Env, groupId: string, seriesId: string): Promise<SeriesView> {
  const found = (await loadSeries(env, groupId)).find((s) => s.id === seriesId);
  if (!found) throw new ApiError(404, "NOT_FOUND", "시리즈를 찾을 수 없습니다.");
  return found;
}

/** 경기 ID → 그 경기가 든 시리즈 ID(시리즈에 없는 경기는 빠진다). 경기 수와 상관없이 질의 1회. */
async function seriesOfMatches(env: Env, groupId: string, matchIds: readonly string[]): Promise<Map<string, string>> {
  const rows = await env.DB.prepare(
    `SELECT match_id, series_id FROM match_series_members
     WHERE group_id = ?1 AND match_id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(groupId, JSON.stringify(matchIds))
    .all<{ match_id: string; series_id: string }>();
  return new Map(rows.results.map((r) => [r.match_id, r.series_id]));
}

/**
 * 시리즈 안의 경기 순서(경기 시각 → 경기 번호). loadSeries(snapshot.ts parseSeries)와 같은 비교라 저장해 두는 응답의
 * matchIds 순서가 다시 읽은 것과 같다.
 */
function playOrderIds(matches: readonly MatchView[]): string[] {
  return [...matches]
    .sort((a, b) => (a.playedAt < b.playedAt ? -1 : a.playedAt > b.playedAt ? 1 : a.matchNo - b.matchNo))
    .map((m) => m.id);
}

/**
 * 요청 기록에 남긴 시리즈(재전송 때 그대로 돌려준다). runMutation의 재생은 처음 응답을 그대로 주는 것이 원칙인데,
 * 예전에는 시리즈를 다시 읽어 그 사이 시리즈가 지워졌으면 같은 요청 ID의 재전송이 404가 됐다(2026-11-08 정합성 점검).
 * 이 변경 전에 남은 요청 기록에는 series가 없어 예전처럼 다시 읽는다.
 */
async function storedSeries(env: Env, groupId: string, stored: Record<string, unknown>, seriesId: string): Promise<SeriesView> {
  if (stored.series && typeof stored.series === "object") return stored.series as SeriesView;
  return findSeries(env, groupId, seriesId);
}

/** 확인한 때의 경기 버전·상태가 저장할 때도 같아야 한다(아니면 batch 전체 실패). */
function matchStillGuard(env: Env, groupId: string, match: MatchView): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (version_conflict)
     SELECT 1 WHERE NOT EXISTS (
       SELECT 1 FROM matches WHERE id = ?1 AND group_id = ?2 AND version = ?3 AND state = ?4
     )`,
  ).bind(match.id, groupId, match.version, match.state);
}

/**
 * 시리즈가 그대로 있고 판 수가 확인한 때와 같아야 한다(다른 기기의 넣기·빼기와 겹치면 실패).
 * 판 수는 지운 경기를 뺀 수다(loadSeries가 지운 경기를 빼고 주므로 같은 기준으로 센다). 그 사이 판을 지우거나
 * 되살려도 수가 달라져 실패한다.
 * CROSS JOIN은 시리즈 소속(idx_series_members)에서 출발해 경기를 기본 키로 찾게 고정한다(snapshot.ts seriesStatements와
 * 같은 이유). 그냥 JOIN이면 계획기가 matches의 (group_id, ...) 색인에서 출발해 모임의 경기 전부(522경기면 약 520행)를 읽었다.
 */
function seriesStillGuard(env: Env, groupId: string, series: SeriesView): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (version_conflict)
     SELECT 1 WHERE (SELECT COUNT(*) FROM match_series_members s
                     CROSS JOIN matches m ON m.id = s.match_id AND m.group_id = s.group_id
                     WHERE s.group_id = ?1 AND s.series_id = ?2 AND m.deleted_at IS NULL) <> ?3
       OR NOT EXISTS (SELECT 1 FROM match_series WHERE group_id = ?1 AND id = ?2)`,
  ).bind(groupId, series.id, series.matchIds.length);
}

/**
 * 지운 경기를 되살릴 때 그 경기가 든 시리즈를 확인한다(matches.ts undeleteMatch).
 * 지운 경기는 시리즈 소속(match_series_members)이 남아 있어, 지운 사이 시리즈에 새 판을 넣고 되살리면 3판 2선승이 4판이
 * 되거나 승부가 난 뒤에 판이 붙었다(2026-11-12 사용자 결정: 이럴 때는 되살리기를 거절한다).
 * 되살린 뒤의 판 수가 형식의 최대 판 수(3판 2선승 3, 5판 3선승 5, 자유 MAX_SERIES_GAMES)를 넘거나, 승부가 난 뒤 판이
 * 생기면(seriesScore.overflow) 거절한다. 괜찮으면 확인한 때의 판 수를 저장 때도 확인하는 보호 문장을 돌려준다.
 * 시리즈에 없는 경기거나, 시리즈의 나머지 판이 모두 지워져 시리즈가 보이지 않으면 아무 확인도 하지 않는다.
 */
export async function seriesUndeleteGuards(env: Env, groupId: string, match: MatchView): Promise<D1PreparedStatement[]> {
  const found = await seriesWith(env, groupId, match.id);
  if (!found) return [];
  const { series, members } = found;
  const after: SeriesView = { ...series, matchIds: [...series.matchIds, match.id] };
  const need = SERIES_WINS_NEEDED[series.format];
  const maxGames = need === null ? MAX_SERIES_GAMES : need * 2 - 1;
  const tooMany = after.matchIds.length > maxGames;
  if (tooMany || seriesScore(after, [...members, match]).overflow) {
    // 둘 다 해당하면 판 수가 더 알아보기 쉬워 먼저 쓴다.
    throw seriesOverflow(series, tooMany ? `이미 ${series.matchIds.length}판이에요` : "이미 승부가 났어요", "되살리면");
  }
  return [seriesStillGuard(env, groupId, series)];
}

/**
 * 전적 제외한 경기를 복구할 때 그 경기가 든 시리즈를 확인한다(matches.ts restoreMatch).
 * 제외한 판은 시리즈 점수에서 빠지므로(seriesScore "dropped") 그 사이 판을 더 넣어 승부가 났을 수 있다. 복구로 승부가 난 뒤에
 * 판이 생기면(overflow가 새로 생기면) 되살리기와 같은 까닭으로 거절한다. 원래 넘쳐 있던 시리즈는 이 복구 탓이 아니라 막지 않는다.
 * 판 수는 그대로라(제외한 판도 시리즈 소속) 판 수 상한은 보지 않는다.
 */
export async function seriesRestoreGuards(
  env: Env,
  groupId: string,
  match: MatchView,
  restoredState: MatchView["state"],
): Promise<D1PreparedStatement[]> {
  const found = await seriesWith(env, groupId, match.id);
  if (!found) return [];
  const { series, members } = found;
  const restored = members.map((m) => (m.id === match.id ? { ...m, state: restoredState } : m));
  if (seriesScore(series, restored).overflow && !seriesScore(series, members).overflow) {
    throw seriesOverflow(series, "이미 승부가 났어요", "복구하면");
  }
  return [seriesStillGuard(env, groupId, series)];
}

/** 경기가 든 시리즈와 그 시리즈의 지우지 않은 경기. 시리즈에 없거나 시리즈가 보이지 않으면 null. */
async function seriesWith(
  env: Env,
  groupId: string,
  matchId: string,
): Promise<{ series: SeriesView; members: MatchView[] } | null> {
  const seriesId = (await seriesOfMatches(env, groupId, [matchId])).get(matchId);
  if (!seriesId) return null;
  const series = (await loadSeries(env, groupId)).find((s) => s.id === seriesId);
  if (!series) return null;
  return { series, members: await loadMatchesByIds(env, groupId, series.matchIds) };
}

function seriesOverflow(series: SeriesView, why: string, doing: string): ApiError {
  const which = series.name ? `"${series.name}" 시리즈` : "시리즈";
  return new ApiError(
    409,
    "SERIES_FULL",
    `이 경기가 든 ${which}(${SERIES_FORMAT_LABEL[series.format]})는 ${why}. ${doing} 형식보다 길어져요. 그 사이 새로 넣은 판을 먼저 지우거나 시리즈에서 뺀 뒤 다시 해 주세요.`,
    { seriesId: series.id },
  );
}

function insertMember(env: Env, groupId: string, seriesId: string, matchId: string, at: string): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO match_series_members (group_id, series_id, match_id, added_at) VALUES (?1, ?2, ?3, ?4)",
  ).bind(groupId, seriesId, matchId, at);
}

function insertSeries(
  env: Env,
  groupId: string,
  seriesId: string,
  name: string | null,
  format: SeriesFormat,
  at: string,
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO match_series (id, group_id, name, format, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  ).bind(seriesId, groupId, name, format, at);
}

/**
 * 시리즈의 판들(명단 포함)과 기준 판(src/shared/series.ts seriesReferenceOf: 제외·취소가 아닌 판들 중 가장 많은 구성).
 * 새 판은 기준 판과 구성이 같아야 한다. 판 수와 상관없이 batch 1회(예전에는 판마다 loadMatch 2회).
 */
async function referenceOf(
  env: Env,
  groupId: string,
  series: SeriesView,
): Promise<{ reference: MatchView | null; members: MatchView[] }> {
  const members = await loadMatchesByIds(env, groupId, series.matchIds);
  return { reference: seriesReferenceOf(members), members };
}

/* ------------------------------------------------------------------ */
/* ① 시리즈로 이어가기(경기 시작)                                        */
/* ------------------------------------------------------------------ */

export interface SeriesContinue {
  /** 직전 경기(같은 팀으로 다음 경기를 준비한 그 경기). */
  fromMatchId: string;
  /** 직전 경기가 아직 시리즈에 없어 새로 만들 때만 쓴다. */
  format: SeriesFormat;
  name: string | null;
}

export function parseSeriesContinue(value: unknown): SeriesContinue | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "INVALID_FIELD", "series 값이 올바르지 않습니다.");
  }
  const raw = value as Body;
  assertOnlyKeys(raw, ["fromMatchId", "format", "name"]);
  return {
    fromMatchId: requireString(raw.fromMatchId, "series.fromMatchId", 1, 64),
    format: raw.format === undefined ? "bo3" : parseFormat(raw.format),
    name: parseName(raw.name),
  };
}

/**
 * 경기 시작 batch에 붙일 문장들: 새 경기를 직전 경기의 시리즈에 넣는다(직전 경기가 시리즈에 없으면 둘을 새 시리즈로).
 * 직전 경기는 이 모임의 경기여야 하고 미진행 취소·전적 제외가 아니어야 하며, 두 팀 구성이 같아야 한다.
 */
export async function seriesContinuePlan(
  env: Env,
  groupId: string,
  input: SeriesContinue,
  newMatchId: string,
  roster: readonly RosterEntry[],
  at: string,
): Promise<D1PreparedStatement[]> {
  const from = await loadMatch(env, groupId, input.fromMatchId);
  if (from.state === "canceled" || from.state === "excluded") {
    throw new ApiError(409, "STATE_CONFLICT", "직전 경기가 취소·전적 제외돼 시리즈로 이어갈 수 없어요.");
  }
  if (compositionKey(from.roster) !== compositionKey(roster)) throw teamsDiffer();
  const existing = (await seriesOfMatches(env, groupId, [from.id])).get(from.id);
  if (existing) {
    const series = await findSeries(env, groupId, existing);
    if (series.matchIds.length >= MAX_SERIES_GAMES) throw tooManyGames();
    const { reference } = await referenceOf(env, groupId, series);
    if (reference && compositionKey(reference.roster) !== compositionKey(roster)) throw teamsDiffer();
    return [seriesStillGuard(env, groupId, series), insertMember(env, groupId, series.id, newMatchId, at)];
  }
  const seriesId = newId();
  return [
    // 직전 경기가 그 사이 다른 시리즈에 들어갔으면 기본 키 충돌로 batch가 실패한다(VERSION_CONFLICT).
    insertSeries(env, groupId, seriesId, input.name, input.format, at),
    insertMember(env, groupId, seriesId, from.id, at),
    insertMember(env, groupId, seriesId, newMatchId, at),
  ];
}

function tooManyGames(): ApiError {
  return new ApiError(409, "SERIES_FULL", `한 시리즈에는 ${MAX_SERIES_GAMES}판까지 넣을 수 있어요.`);
}

/* ------------------------------------------------------------------ */
/* ② 기록 화면·경기 상세에서 만들기·넣기·빼기·고치기                    */
/* ------------------------------------------------------------------ */

/**
 * 시리즈에 넣을 수 있는 경기들(준 순서대로): 이 모임의 결과 확정 경기, 아직 다른 시리즈에 없음.
 * 경기 수와 상관없이 질의 2회(경기·명단 batch 1회 + 시리즈 소속 1회). 예전에는 경기마다 3회라 15판 만들기가 50회를 넘었다.
 * 오류는 예전처럼 준 순서대로 첫 문제 경기의 것(없음 404 → 확정 아님 → 다른 시리즈에 있음).
 */
async function loadJoinables(env: Env, groupId: string, matchIds: readonly string[]): Promise<MatchView[]> {
  const found = new Map((await loadMatchesByIds(env, groupId, matchIds)).map((m) => [m.id, m]));
  const inSeries = await seriesOfMatches(env, groupId, matchIds);
  return matchIds.map((id) => {
    const match = found.get(id);
    if (!match) throw new ApiError(404, "NOT_FOUND", "경기를 찾을 수 없습니다.");
    if (match.state !== "confirmed") {
      throw new ApiError(409, "STATE_CONFLICT", "결과가 확정된 경기만 시리즈에 넣을 수 있어요.", {
        match: { version: match.version, state: match.state },
      });
    }
    if (inSeries.has(id)) {
      throw new ApiError(409, "ALREADY_IN_SERIES", `${match.matchNo}경기는 이미 다른 시리즈에 있어요. 먼저 그 시리즈에서 빼 주세요.`);
    }
    return match;
  });
}

/** 새 시리즈: 확정 경기 1판 이상, 두 팀 구성이 모두 같아야 한다. */
export async function createSeries(env: Env, groupId: string, body: Body): Promise<{ series: SeriesView }> {
  assertOnlyKeys(body, ["requestId", "name", "format", "matchIds"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const name = parseName(body.name);
  const format = parseFormat(body.format);
  if (!Array.isArray(body.matchIds) || body.matchIds.length < 1 || body.matchIds.length > MAX_SERIES_GAMES) {
    throw new ApiError(400, "INVALID_FIELD", `시리즈에는 1~${MAX_SERIES_GAMES}판을 넣을 수 있어요.`);
  }
  const matchIds = body.matchIds.map((id) => requireString(id, "matchIds", 1, 64));
  if (new Set(matchIds).size !== matchIds.length) {
    throw new ApiError(400, "INVALID_FIELD", "같은 경기가 두 번 들어 있습니다.");
  }
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "series-create",
    payload: { name, format, matchIds },
    build: async (): Promise<Plan> => {
      const matches = await loadJoinables(env, groupId, matchIds);
      const key = compositionKey(matches[0]!.roster);
      const differ = matches.filter((m) => compositionKey(m.roster) !== key);
      if (differ.length > 0) throw teamsDiffer({ matchNos: differ.map((m) => m.matchNo) });
      const seriesId = newId();
      const at = nowIso();
      const series: SeriesView = { id: seriesId, name, format, createdAt: at, matchIds: playOrderIds(matches) };
      return {
        stored: { seriesId, series },
        statements: [
          ...matches.map((m) => matchStillGuard(env, groupId, m)),
          insertSeries(env, groupId, seriesId, name, format, at),
          ...matches.map((m) => insertMember(env, groupId, seriesId, m.id, at)),
        ],
      };
    },
  });
  return { series: await storedSeries(env, groupId, stored, stored.seriesId as string) };
}

/** 확정 경기를 기존 시리즈에 넣는다. 시리즈의 기준 판(가장 많은 구성)과 두 팀 구성이 같아야 한다. */
export async function addToSeries(
  env: Env,
  groupId: string,
  seriesId: string,
  body: Body,
): Promise<{ series: SeriesView }> {
  assertOnlyKeys(body, ["requestId", "matchId"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const matchId = requireString(body.matchId, "matchId", 1, 64);
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "series-add",
    payload: { seriesId, matchId },
    build: async (): Promise<Plan> => {
      const series = await findSeries(env, groupId, seriesId);
      const [match] = await loadJoinables(env, groupId, [matchId]);
      if (series.matchIds.length >= MAX_SERIES_GAMES) throw tooManyGames();
      const { reference, members } = await referenceOf(env, groupId, series);
      if (reference && compositionKey(reference.roster) !== compositionKey(match!.roster)) throw teamsDiffer();
      const statements = [seriesStillGuard(env, groupId, series), matchStillGuard(env, groupId, match!)];
      if (reference) statements.push(matchStillGuard(env, groupId, reference));
      statements.push(insertMember(env, groupId, series.id, match!.id, nowIso()));
      const after: SeriesView = { ...series, matchIds: playOrderIds([...members, match!]) };
      return { stored: { seriesId, series: after }, statements };
    },
  });
  return { series: await storedSeries(env, groupId, stored, seriesId) };
}

/**
 * 시리즈에서 한 판을 뺀다. 마지막 판을 빼면 시리즈도 지운다. 경기 기록은 그대로다.
 * 보이는 마지막 판을 빼도 지운 경기(migrations/0026)가 시리즈에 남아 있으면 시리즈 행은 지우지 않는다(소속 행이 외래 키로
 * 걸려 있고, 그 경기를 되살리면 시리즈째 돌아와야 한다). 그동안 시리즈는 판이 없어 화면에 보이지 않는다.
 */
export async function removeFromSeries(
  env: Env,
  groupId: string,
  seriesId: string,
  body: Body,
): Promise<{ series: SeriesView | null }> {
  assertOnlyKeys(body, ["requestId", "matchId"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const matchId = requireString(body.matchId, "matchId", 1, 64);
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "series-remove",
    payload: { seriesId, matchId },
    build: async (): Promise<Plan> => {
      const series = await findSeries(env, groupId, seriesId);
      if (!series.matchIds.includes(matchId)) {
        throw new ApiError(404, "NOT_FOUND", "이 시리즈에 없는 경기입니다.");
      }
      // CROSS JOIN: seriesStillGuard와 같은 이유로 시리즈 소속에서 출발한다.
      const hidden = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM match_series_members s
         CROSS JOIN matches m ON m.id = s.match_id AND m.group_id = s.group_id
         WHERE s.group_id = ?1 AND s.series_id = ?2 AND m.deleted_at IS NOT NULL`,
      )
        .bind(groupId, seriesId)
        .first<{ n: number }>();
      const emptied = series.matchIds.length === 1;
      const last = emptied && (hidden?.n ?? 0) === 0;
      const statements = [
        seriesStillGuard(env, groupId, series),
        env.DB.prepare(
          "DELETE FROM match_series_members WHERE group_id = ?1 AND series_id = ?2 AND match_id = ?3",
        ).bind(groupId, seriesId, matchId),
      ];
      if (last) {
        statements.push(
          env.DB.prepare("DELETE FROM match_series WHERE group_id = ?1 AND id = ?2").bind(groupId, seriesId),
        );
      }
      const after: SeriesView | null = emptied ? null : { ...series, matchIds: series.matchIds.filter((id) => id !== matchId) };
      return { stored: { deleted: emptied, series: after }, statements };
    },
  });
  if (stored.deleted === true) return { series: null };
  return { series: await storedSeries(env, groupId, stored, seriesId) };
}

/** 시리즈 이름·형식을 고친다. */
export async function updateSeries(
  env: Env,
  groupId: string,
  seriesId: string,
  body: Body,
): Promise<{ series: SeriesView }> {
  assertOnlyKeys(body, ["requestId", "name", "format"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const name = parseName(body.name);
  const format = parseFormat(body.format);
  const { stored } = await runMutation(env, {
    groupId,
    requestId,
    op: "series-update",
    payload: { seriesId, name, format },
    build: async (): Promise<Plan> => {
      const series = await findSeries(env, groupId, seriesId);
      return {
        stored: { seriesId, series: { ...series, name, format } },
        statements: [
          env.DB.prepare("UPDATE match_series SET name = ?1, format = ?2 WHERE group_id = ?3 AND id = ?4").bind(
            name,
            format,
            groupId,
            seriesId,
          ),
        ],
      };
    },
  });
  return { series: await storedSeries(env, groupId, stored, seriesId) };
}
