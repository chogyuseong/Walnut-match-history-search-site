/**
 * 시리즈 묶음(migrations/0017). 여러 경기를 한 시리즈(3판 2선승·5판 3선승·자유)로 묶는다.
 *
 * - 만드는 길 두 가지: ① 경기 시작 때 "시리즈로 이어가기"(startMatch의 series 선택 필드, seriesContinuePlan)
 *   ② 기록 화면·경기 상세에서 확정 경기로 새 시리즈를 만들거나(createSeries) 넣고 빼기(addToSeries, removeFromSeries).
 * - 두 팀의 5명 구성이 시리즈의 첫 판과 같아야 넣을 수 있다(src/shared/series.ts compositionKey). 다르면 거절한다.
 * - 한 경기는 한 시리즈에만 들어간다(match_series_members 기본 키). 마지막 판을 빼면 시리즈도 지운다.
 * - 모임 경계: 경기·시리즈는 그 모임의 것만 찾는다(group_id 조건). 표의 복합 외래 키도 막는다.
 * - 경기 버전·진행 상태 버전은 올리지 않는다(시리즈는 기록을 묶어 보여 주는 것뿐이고 승패·명단은 그대로다).
 *   대신 확인한 때의 경기 버전·상태가 저장할 때도 같은지 보호 문장으로 확인한다(그 사이 참가자 교체 정정 등).
 */
import {
  byPlayOrder,
  compositionKey,
  SERIES_NAME_MAX,
  SERIES_TEAMS_DIFFER_TEXT,
} from "../shared/series";
import { cleanName } from "../shared/names";
import { SERIES_FORMATS, type MatchView, type RosterEntry, type SeriesFormat, type SeriesView } from "../shared/types";
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, newId, nowIso, requireOneOf, requireString } from "./http";
import { runMutation, type Plan } from "./mutation";
import { loadMatch, loadSeries } from "./snapshot";

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

async function seriesOfMatch(env: Env, groupId: string, matchId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT series_id FROM match_series_members WHERE group_id = ?1 AND match_id = ?2",
  )
    .bind(groupId, matchId)
    .first<{ series_id: string }>();
  return row?.series_id ?? null;
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

/** 시리즈가 그대로 있고 판 수가 확인한 때와 같아야 한다(다른 기기의 넣기·빼기와 겹치면 실패). */
function seriesStillGuard(env: Env, groupId: string, series: SeriesView): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO guard (version_conflict)
     SELECT 1 WHERE (SELECT COUNT(*) FROM match_series_members WHERE group_id = ?1 AND series_id = ?2) <> ?3
       OR NOT EXISTS (SELECT 1 FROM match_series WHERE group_id = ?1 AND id = ?2)`,
  ).bind(groupId, series.id, series.matchIds.length);
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

/** 시리즈의 기준 판(첫 판). 새 판은 이 판과 구성이 같아야 한다. */
async function referenceOf(env: Env, groupId: string, series: SeriesView): Promise<MatchView | null> {
  const members = await Promise.all(series.matchIds.map((id) => loadMatch(env, groupId, id)));
  return members.sort(byPlayOrder)[0] ?? null;
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
  const existing = await seriesOfMatch(env, groupId, from.id);
  if (existing) {
    const series = await findSeries(env, groupId, existing);
    if (series.matchIds.length >= MAX_SERIES_GAMES) throw tooManyGames();
    const reference = await referenceOf(env, groupId, series);
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

/** 시리즈에 넣을 수 있는 경기: 이 모임의 결과 확정 경기, 아직 다른 시리즈에 없음. */
async function loadJoinable(env: Env, groupId: string, matchId: string): Promise<MatchView> {
  const match = await loadMatch(env, groupId, matchId);
  if (match.state !== "confirmed") {
    throw new ApiError(409, "STATE_CONFLICT", "결과가 확정된 경기만 시리즈에 넣을 수 있어요.", {
      match: { version: match.version, state: match.state },
    });
  }
  if (await seriesOfMatch(env, groupId, matchId)) {
    throw new ApiError(409, "ALREADY_IN_SERIES", `${match.matchNo}경기는 이미 다른 시리즈에 있어요. 먼저 그 시리즈에서 빼 주세요.`);
  }
  return match;
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
      const matches: MatchView[] = [];
      for (const id of matchIds) matches.push(await loadJoinable(env, groupId, id));
      const key = compositionKey(matches[0]!.roster);
      const differ = matches.filter((m) => compositionKey(m.roster) !== key);
      if (differ.length > 0) throw teamsDiffer({ matchNos: differ.map((m) => m.matchNo) });
      const seriesId = newId();
      const at = nowIso();
      return {
        stored: { seriesId },
        statements: [
          ...matches.map((m) => matchStillGuard(env, groupId, m)),
          insertSeries(env, groupId, seriesId, name, format, at),
          ...matches.map((m) => insertMember(env, groupId, seriesId, m.id, at)),
        ],
      };
    },
  });
  return { series: await findSeries(env, groupId, stored.seriesId as string) };
}

/** 확정 경기를 기존 시리즈에 넣는다. 시리즈의 첫 판과 두 팀 구성이 같아야 한다. */
export async function addToSeries(
  env: Env,
  groupId: string,
  seriesId: string,
  body: Body,
): Promise<{ series: SeriesView }> {
  assertOnlyKeys(body, ["requestId", "matchId"]);
  const requestId = requireString(body.requestId, "requestId", 8, 64);
  const matchId = requireString(body.matchId, "matchId", 1, 64);
  await runMutation(env, {
    groupId,
    requestId,
    op: "series-add",
    payload: { seriesId, matchId },
    build: async (): Promise<Plan> => {
      const series = await findSeries(env, groupId, seriesId);
      const match = await loadJoinable(env, groupId, matchId);
      if (series.matchIds.length >= MAX_SERIES_GAMES) throw tooManyGames();
      const reference = await referenceOf(env, groupId, series);
      if (reference && compositionKey(reference.roster) !== compositionKey(match.roster)) throw teamsDiffer();
      const statements = [seriesStillGuard(env, groupId, series), matchStillGuard(env, groupId, match)];
      if (reference) statements.push(matchStillGuard(env, groupId, reference));
      statements.push(insertMember(env, groupId, series.id, match.id, nowIso()));
      return { stored: { seriesId }, statements };
    },
  });
  return { series: await findSeries(env, groupId, seriesId) };
}

/** 시리즈에서 한 판을 뺀다. 마지막 판을 빼면 시리즈도 지운다. 경기 기록은 그대로다. */
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
      const last = series.matchIds.length === 1;
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
      return { stored: { deleted: last }, statements };
    },
  });
  if (stored.deleted === true) return { series: null };
  return { series: await findSeries(env, groupId, seriesId) };
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
  await runMutation(env, {
    groupId,
    requestId,
    op: "series-update",
    payload: { seriesId, name, format },
    build: async (): Promise<Plan> => {
      await findSeries(env, groupId, seriesId);
      return {
        stored: { seriesId },
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
  return { series: await findSeries(env, groupId, seriesId) };
}
