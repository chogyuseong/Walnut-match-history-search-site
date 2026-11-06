/**
 * 사이트 운영자(이 서비스의 주인) 현황. 모임 운영자·공동 운영자 권한(requireOperator·requireOwner)과 섞지 않는다.
 * 사이트 운영자는 환경 변수 SITE_ADMIN_ACCOUNT_IDS(쉼표 구분 계정 ID)로만 정한다. 비어 있으면 아무도 아니다.
 * 사이트 운영자가 아니면(로그인하지 않은 경우 포함) 경로가 없는 것처럼 404를 돌려준다.
 *
 * 보여 주는 것은 전체 수치와 오류 기록뿐이다. 모임 이름·참가자 이름·경기 내용 등 모임 안의 자료는 읽지도 돌려주지도 않는다.
 */
import { fakeLoginEnabled, readSession } from "./auth";
import type { Env } from "./env";
import { ApiError } from "./http";

const DAY_MS = 24 * 3600_000;

function adminEntries(env: Env): string[] {
  return (env.SITE_ADMIN_ACCOUNT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * 이 요청이 사이트 운영자의 것인지.
 * - 계정 ID가 목록에 있으면 맞다.
 * - 로컬 가짜 로그인이 열려 있을 때만(fakeLoginEnabled: AUTH_MODE=fake, DEPLOY_ENV=local, 로컬 주소) "fake:로그인이름"도 맞춰 본다.
 *   가짜 계정의 ID는 로그인할 때 무작위로 정해져 미리 적을 수 없어서 둔 로컬 전용 꼴이다. 운영에서는 무시된다.
 */
export async function isSiteAdmin(env: Env, req: Request): Promise<boolean> {
  const entries = adminEntries(env);
  if (entries.length === 0) return false;
  const session = await readSession(env, req);
  if (!session) return false;
  if (entries.includes(session.id)) return true;
  if (session.provider === "fake" && fakeLoginEnabled(env, req)) {
    const row = await env.DB.prepare("SELECT subject FROM accounts WHERE id = ?1")
      .bind(session.id)
      .first<{ subject: string }>();
    return row !== null && entries.includes(`fake:${row.subject}`);
  }
  return false;
}

export async function requireSiteAdmin(env: Env, req: Request): Promise<void> {
  if (!(await isSiteAdmin(env, req))) throw new ApiError(404, "NOT_FOUND", "찾을 수 없습니다.");
}

/** 오류 목록에 묶어 보여 줄 최대 줄 수. */
export const OVERVIEW_ERROR_GROUPS = 50;

export interface ErrorGroupView {
  source: "client" | "server";
  kind: string;
  message: string;
  path: string | null;
  count: number;
  firstAt: string;
  lastAt: string;
  /** 가장 최근 한 건의 스택(가린 값). */
  stack: string | null;
  appVersion: string | null;
  browser: string | null;
}

export interface Overview {
  generatedAt: string;
  totals: { accounts: number; groups: number; matches: number; confirmedMatches: number; participants: number };
  recent: {
    days: number;
    /** 이 기간에 경기가 기록된(시작·확정·입력) 모임 수. */
    activeGroups: number;
    newAccounts: number;
    newGroups: number;
  }[];
  errors: {
    total: number;
    byKind: { source: string; kind: string; count: number }[];
    groups: ErrorGroupView[];
  };
  /** 요청 수 제한에 걸린 횟수(종류별, 최근 7일·30일). */
  rateLimited: { bucket: string; last7: number; last30: number }[];
}

async function countOf(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function siteOverview(env: Env, now = Date.now()): Promise<Overview> {
  const since = (days: number) => new Date(now - days * DAY_MS).toISOString();
  const recent = await Promise.all(
    [7, 30].map(async (days) => ({
      days,
      activeGroups: await countOf(
        env,
        `SELECT COUNT(DISTINCT group_id) AS n FROM matches
         WHERE COALESCE(confirmed_at, started_at, played_at) >= ?1`,
        since(days),
      ),
      newAccounts: await countOf(env, "SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ?1", since(days)),
      newGroups: await countOf(env, "SELECT COUNT(*) AS n FROM groups WHERE created_at >= ?1", since(days)),
    })),
  );
  const byKind = await env.DB.prepare(
    "SELECT source, kind, COUNT(*) AS count FROM error_logs GROUP BY source, kind ORDER BY count DESC",
  ).all<{ source: string; kind: string; count: number }>();
  // 같은 출처·종류·메시지·경로를 한 줄로 묶는다. 스택·버전·브라우저는 가장 최근 한 건의 값이다.
  const groups = await env.DB.prepare(
    `SELECT g.source, g.kind, g.message, g.path, g.count, g.first_at, g.last_at,
       e.stack, e.app_version, e.browser
     FROM (
       SELECT source, kind, message, path, COUNT(*) AS count, MIN(created_at) AS first_at,
         MAX(created_at) AS last_at, MAX(id) AS last_id
       FROM error_logs GROUP BY source, kind, message, path
     ) g JOIN error_logs e ON e.id = g.last_id
     ORDER BY g.last_at DESC LIMIT ?1`,
  )
    .bind(OVERVIEW_ERROR_GROUPS)
    .all<{
      source: "client" | "server";
      kind: string;
      message: string;
      path: string | null;
      count: number;
      first_at: string;
      last_at: string;
      stack: string | null;
      app_version: string | null;
      browser: string | null;
    }>();
  const day = (days: number) => new Date(now - days * DAY_MS).toISOString().slice(0, 10);
  const rate = await env.DB.prepare(
    `SELECT bucket,
       SUM(CASE WHEN day > ?1 THEN count ELSE 0 END) AS last7,
       SUM(count) AS last30
     FROM rate_limit_hits WHERE day > ?2 GROUP BY bucket ORDER BY last30 DESC`,
  )
    .bind(day(7), day(30))
    .all<{ bucket: string; last7: number; last30: number }>();

  return {
    generatedAt: new Date(now).toISOString(),
    totals: {
      accounts: await countOf(env, "SELECT COUNT(*) AS n FROM accounts"),
      groups: await countOf(env, "SELECT COUNT(*) AS n FROM groups"),
      matches: await countOf(env, "SELECT COUNT(*) AS n FROM matches"),
      confirmedMatches: await countOf(env, "SELECT COUNT(*) AS n FROM matches WHERE state = 'confirmed'"),
      participants: await countOf(env, "SELECT COUNT(*) AS n FROM participants"),
    },
    recent,
    errors: {
      total: await countOf(env, "SELECT COUNT(*) AS n FROM error_logs"),
      byKind: byKind.results,
      groups: groups.results.map((g) => ({
        source: g.source,
        kind: g.kind,
        message: g.message,
        path: g.path,
        count: g.count,
        firstAt: g.first_at,
        lastAt: g.last_at,
        stack: g.stack,
        appVersion: g.app_version,
        browser: g.browser,
      })),
    },
    rateLimited: rate.results.map((r) => ({ bucket: r.bucket, last7: r.last7 ?? 0, last30: r.last30 ?? 0 })),
  };
}

export async function clearErrorLogs(env: Env): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM error_logs").run();
  return result.meta.changes ?? 0;
}
