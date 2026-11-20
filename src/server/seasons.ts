// 시즌 만들기·지우기. 시즌은 기록을 날짜로 나눠 보는 필터라 경기·배치·칭호를 바꾸지 않는다.
import type { Env } from "./env";
import { ApiError, assertOnlyKeys, newId, nowIso, requireRequestId } from "./http";
import { runMutation } from "./mutation";
import { parseName } from "./groups";

type Body = Record<string, unknown>;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    throw new ApiError(400, "INVALID_FIELD", `${field} 값이 올바르지 않습니다.`);
  }
  // 2026-02-31 같은 없는 날짜를 거른다.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, "INVALID_FIELD", `${field} 값이 올바르지 않습니다.`);
  }
  return value;
}

/**
 * 시즌을 만든다. 기존 시즌과 날짜가 겹치면 거절한다.
 * 겹침 검사와 저장을 한 batch로 실행해 사이에 다른 시즌이 끼어들 수 없게 한다.
 */
export async function createSeason(
  env: Env,
  groupId: string,
  body: Body,
): Promise<{ id: string }> {
  assertOnlyKeys(body, ["name", "startsOn", "endsOn", "requestId"]);
  const name = parseName(body.name);
  const startsOn = parseDate(body.startsOn, "startsOn");
  const endsOn = parseDate(body.endsOn, "endsOn");
  if (startsOn > endsOn) {
    throw new ApiError(400, "INVALID_FIELD", "시작일이 종료일보다 늦습니다.");
  }
  const overlap = () => new ApiError(409, "SEASON_OVERLAP", "다른 시즌과 날짜가 겹칩니다.");
  try {
    const { stored } = await runMutation(env, {
      groupId,
      requestId: requireRequestId(body),
      op: "create-season",
      payload: { name, startsOn, endsOn },
      build: async () => {
        const id = newId();
        return {
          stored: { id },
          statements: [
            env.DB.prepare(
              `INSERT INTO guard (state_conflict)
               SELECT 1 WHERE EXISTS (
                 SELECT 1 FROM seasons
                 WHERE group_id = ?1 AND starts_on <= ?3 AND ends_on >= ?2
               )`,
            ).bind(groupId, startsOn, endsOn),
            env.DB.prepare(
              `INSERT INTO seasons (id, group_id, name, starts_on, ends_on, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
            ).bind(id, groupId, name, startsOn, endsOn, nowIso()),
          ],
        };
      },
    });
    return { id: stored.id as string };
  } catch (error) {
    // 겹침 보호 문장(guard_state_conflict)은 공통 경로가 VERSION_CONFLICT로 바꾼다. 시즌에서는 겹침이라는 뜻이다.
    if (error instanceof ApiError && error.code === "VERSION_CONFLICT") throw overlap();
    throw error;
  }
}

/** 시즌을 지운다. 시즌은 통계 필터일 뿐이라 경기·배치·칭호는 바뀌지 않는다. 본문 { requestId }(필수). */
export async function deleteSeason(env: Env, groupId: string, seasonId: string, body: Body = {}): Promise<void> {
  assertOnlyKeys(body, ["requestId"]);
  await runMutation(env, {
    groupId,
    requestId: requireRequestId(body),
    op: "delete-season",
    payload: { seasonId },
    build: async () => ({
      stored: {},
      statements: [env.DB.prepare("DELETE FROM seasons WHERE id = ?1 AND group_id = ?2").bind(seasonId, groupId)],
    }),
  });
}
