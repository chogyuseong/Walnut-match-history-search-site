import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { MAX_IMPORT_MATCHES } from "../src/server/matches";
import { snapshotCost } from "../src/server/ratelimit";
import {
  loadEtagHead,
  loadEtagHeadByViewToken,
  parseSnapshot,
  snapshotStatements,
} from "../src/server/snapshot";
import type { ParticipantView, Position, RosterEntry, Snapshot } from "../src/shared/types";
import { direct } from "./direct";
import { api, playConfirmed, requestId, rosterOf, setupGroup, start, unique, type TestGroup } from "./helpers";

/**
 * 스냅숏 한 번이 D1에서 실제로 읽는 행 수(meta.rows_read) 측정. 숫자는 콘솔 표로 찍고, 단언은 고친 쓰기 경로의 상한뿐이다
 * (결과 저장, 시리즈 빼기·넣기, 경기 취소, 합치기의 차례 기록 문장, 요청 수 제한 정리. 스냅숏 합계는 문장을 줄여 가는
 * 중이라 상한을 걸지 않는다).
 *
 * 왜: 무료 요금제 D1 하루 읽기 한도는 500만 행이다. 하루 읽기 예산(ratelimit.ts snapshotCost = 300 + 16 × 경기 수)은
 * 이 측정의 경기당 행 수에 맞춘 추정이다. 어느 문장을 줄일지 정하려면 문장별 실측이 필요하다. rows_read는 서버 안(batch 결과의 meta)에서만 보이므로 Workers 풀 테스트로 잰다
 * (test/measure/는 Node에서 로컬 서버를 부르는 측정이라 이 값을 볼 수 없다).
 *
 * 자료는 운영 중인 큰 모임과 비슷하게 만든다: 참가자 26명(그중 부캐 2명은 합치기), 기존 사이트에서 가져온 확정 경기
 * (가져오기 API로 넣어 경기마다 backfill 이력 한 줄이 생긴다), 시즌 2개, bo3 시리즈 2개, 열린 내전에서 결과까지 낸
 * 경기 몇 개와 결과를 아직 넣지 않은 경기 1개(순환 주기·차례 기록이 생긴다).
 *
 * 로컬 D1(miniflare)의 rows_read는 같은 SQLite가 세는 값이라 운영 D1과 계획이 같으면 같은 수가 나와야 하지만,
 * 운영 D1은 ANALYZE 통계가 다를 수 있어 계획이 갈릴 수 있다. 큰 차이가 의심되면 운영에서 한 번 맞춰 본다.
 */

/** 운영 모임의 경기 수(2026-11 기준)와 비교용 중간 크기. */
const BIG_GROUP_MATCHES = 522;
const MID_GROUP_MATCHES = 100;
/** 본 참가자 수. 여기에 합치기로 사라질 부캐 2명을 더해 26명이다. */
const MAIN_PLAYERS = 24;
/** 열린 내전에서 결과까지 낸 경기 수와, 시작만 하고 결과를 넣지 않은 경기 수. 나머지는 가져오기로 넣는다. */
const LIVE_CONFIRMED = 2;
const LIVE_IN_PROGRESS = 1;
/** 가져온 경기는 같은 두 팀이 이만큼 연달아 붙는다(bo3 시리즈를 만들 수 있게). */
const SAME_TEAMS_RUN = 3;
/** 팀 구성 하나에서 다음 구성으로 넘어갈 때 참가자 목록에서 건너뛰는 칸 수(24와 서로소라 고르게 돈다). */
const ROSTER_STRIDE = 7;
/** 부캐가 본캐 대신 뛴 구성: 구성 번호를 이 수로 나눈 나머지가 0이면 부캐1, 절반이면 부캐2. */
const ALT_EVERY = 8;
const FIRST_PLAYED_AT = Date.parse("2025-11-01T12:00:00.000Z");
const PLAY_INTERVAL_MS = 12 * 3600_000;
const LEGACY_SOURCE_KEY = `legacy:${"x".repeat(30)}`;
/** 보통 몇 초면 끝난다(522경기 넣기 = 가져오기 11번 + 합치기·시리즈·실제 경기). 느린 CI를 감안해 기본 한도보다만 넉넉히 둔다. */
const MEASURE_TIMEOUT_MS = 120_000;
/**
 * 522경기 모임에서 결과 저장 요청 하나가 읽어도 되는 행 수의 상한. 고친 뒤 실측은 64행(경기 하나의 명단을 기본 키로
 * 찾는다)이고, 명단 질의가 다시 모임 명단 전체를 훑으면 1만 행을 넘는다. 경기 수와 무관한 값이라 넉넉히 3배쯤 둔다.
 */
const SAVE_ROWS_READ_CEILING = 200;
/** 결과 저장 요청에서 rows_read가 큰 순으로 찍을 문장 수. */
const HEAVIEST_SAVE_STATEMENTS = 8;

/**
 * 다른 모임들의 서포터 차례 기록 행 수. 차례 기록은 실제 경기마다 약 2행씩 모든 모임에 걸쳐 쌓이고, 질의가 색인으로
 * 범위를 좁히지 못하면 이 행까지 읽는다(migrations/0027 전에는 취소·합치기·스냅숏의 차례 질의가 하나에 약 2,010행).
 */
const OTHER_GROUPS_ROTATION_ROWS = 2000;
/**
 * 522경기 모임의 시리즈 빼기·넣기, 경기 취소 요청 하나가 읽어도 되는 행 수의 상한. 실측은 빼기 46·넣기 91·취소 64행이다.
 * 시리즈 보호 문장이 다시 모임의 경기 전부를 훑으면 500행을, 취소의 반복 사건 질의가 차례 기록 전부를 훑으면 2,000행을 넘는다.
 */
const WRITE_ROWS_READ_CEILING = 300;
/**
 * 합치기 요청의 차례 기록 문장 합계와 스냅숏의 "순환 차례 기록" 문장의 상한(실측 20행·13행). 합치기 요청 전체는 누적
 * 승패를 다시 계산하느라 모임 명단을 읽어(약 8,200행) 이번 측정 대상이 아니다.
 */
const ROTATION_ROWS_READ_CEILING = 100;
/** 하루 창(UTC 0시 시작) 요청 수 제한 행. 오늘 스냅숏을 받은 IP·계정·조회 링크마다 하나씩 생긴다. */
const TODAY_DAILY_RATE_ROWS = 1000;
/**
 * 요청 하나의 요청 수 제한 정리 문장(분 단위 둘 + 하루 창 하나) 합계의 상한. 실측 5~9행(실제로 지울 지난 창 행 수만큼 달라진다). 정리가 오늘 하루 창 행을 다시
 * 읽으면 정리 하나에 TODAY_DAILY_RATE_ROWS행을 넘는다.
 */
const RATE_CLEANUP_ROWS_READ_CEILING = 50;
/** 시리즈 소속 질의(series.ts)와 차례 기록 질의(matches.ts 취소, merge.ts)를 고르는 SQL 조각. */
const SERIES_SQL = /match_series_members/;
const ROTATION_SQL = /rotation_events/;

const POSITIONS: Position[] = ["top", "jungle", "mid", "adc", "support"];

/* ------------------------------------------------------------------ */
/* rows_read를 모으는 D1 감싸개                                          */
/* ------------------------------------------------------------------ */

interface ReadTally {
  queries: number;
  rowsRead: number;
  rowsWritten: number;
  /**
   * 문장마다 SQL 앞부분과 rows_read(batch 안의 문장도 하나씩). 많이 읽는 문장을 찾을 때 본다. text는 공백만 줄인
   * SQL 전체다(보호 문장처럼 앞부분이 INSERT INTO guard로 같은 문장을 표 이름으로 고를 때 쓴다).
   */
  perStatement: { sql: string; text: string; rowsRead: number }[];
}

const sqlHead = (sql: string) => sql.replace(/\s+/g, " ").trim().slice(0, 90);

type LooseStatement = Record<string, (...args: unknown[]) => unknown>;

/**
 * 요청 하나가 D1에서 읽고 쓴 행 수를 모은다(test/queryCount.ts countingDb와 같은 방식으로 문장을 감싼다).
 * first()·raw()는 meta를 주지 않으므로 all()로 바꿔 불러 meta를 얻고 같은 모양으로 돌려준다. 같은 SQL을 두 번 돌리지 않으려는 것이다
 * (쓰기 문장을 두 번 돌리면 상태가 바뀐다). 그래서 first(column)·raw({columnNames})는 측정에 필요한 만큼만 흉내 낸다.
 */
function rowsReadingDb(db: D1Database): { db: D1Database; tally: ReadTally } {
  const tally: ReadTally = { queries: 0, rowsRead: 0, rowsWritten: 0, perStatement: [] };
  const add = (sql: string, meta: D1Meta | undefined) => {
    tally.rowsRead += meta?.rows_read ?? 0;
    tally.rowsWritten += meta?.rows_written ?? 0;
    tally.perStatement.push({ sql: sqlHead(sql), text: sql.replace(/\s+/g, " "), rowsRead: meta?.rows_read ?? 0 });
  };
  const sqlOf = (statement: D1PreparedStatement) => (statement as unknown as { statement?: string }).statement ?? "";
  const patch = (statement: D1PreparedStatement): D1PreparedStatement => {
    const s = statement as unknown as LooseStatement;
    const all = s.all!.bind(statement) as () => Promise<D1Result<Record<string, unknown>>>;
    const run = s.run!.bind(statement) as () => Promise<D1Result>;
    s.all = async () => {
      tally.queries += 1;
      const out = await all();
      add(sqlOf(statement), out.meta);
      return out;
    };
    s.run = async () => {
      tally.queries += 1;
      const out = await run();
      add(sqlOf(statement), out.meta);
      return out;
    };
    s.first = async (column?: unknown) => {
      const row = ((await s.all!()) as D1Result<Record<string, unknown>>).results[0] ?? null;
      if (typeof column === "string") return row === null ? null : (row[column] ?? null);
      return row;
    };
    s.raw = async (options?: unknown) => {
      const rows = ((await s.all!()) as D1Result<Record<string, unknown>>).results;
      const values = rows.map((r) => Object.values(r));
      const withNames = (options as { columnNames?: boolean } | undefined)?.columnNames === true;
      return withNames && rows[0] ? [Object.keys(rows[0]), ...values] : values;
    };
    const bind = s.bind!.bind(statement);
    s.bind = (...values: unknown[]) => patch(bind(...values) as D1PreparedStatement);
    return statement;
  };
  const proxy = {
    prepare: (sql: string) => patch(db.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      tally.queries += 1;
      const results = await db.batch(statements);
      results.forEach((r, i) => add(sqlOf(statements[i]!), r.meta));
      return results;
    },
    exec: (sql: string) => {
      tally.queries += 1;
      return db.exec(sql);
    },
    dump: () => db.dump(),
    withSession: () => {
      throw new Error("rowsReadingDb: withSession은 세지 않는다");
    },
  };
  return { db: proxy as unknown as D1Database, tally };
}

/** 요청 하나를 서버에 직접 보내고 그 요청이 읽고 쓴 행 수를 돌려준다. */
async function measuredRequest(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; etag: string | null; tally: ReadTally }> {
  const { db, tally } = rowsReadingDb(env.DB);
  const response = await direct({ DB: db }, method, path, {
    cookie: options.cookie,
    body: options.body,
    headers: { "CF-Connecting-IP": unique("ip"), ...(options.headers ?? {}) },
  });
  await response.arrayBuffer();
  return { status: response.status, etag: response.headers.get("ETag"), tally };
}

/* ------------------------------------------------------------------ */
/* 모임 자료 만들기                                                      */
/* ------------------------------------------------------------------ */

/**
 * 가져올 경기 하나의 명단. 같은 구성(SAME_TEAMS_RUN판)마다 본 참가자 24명 중 10명을 ROSTER_STRIDE칸씩 밀어 고른다.
 * 일부 구성에서는 부캐가 본캐 자리를 대신한다(합치기를 해도 한 경기에 같은 사람이 둘이 되지 않게 본캐는 빠진다).
 */
function importedRoster(matchIndex: number, mains: ParticipantView[], alts: [ParticipantView, ParticipantView]): RosterEntry[] {
  const lineup = Math.floor(matchIndex / SAME_TEAMS_RUN);
  const picked = Array.from({ length: 10 }, (_, j) => mains[(lineup * ROSTER_STRIDE + j) % MAIN_PLAYERS]!);
  const swap = (main: ParticipantView, alt: ParticipantView) => {
    const at = picked.findIndex((p) => p.id === main.id);
    if (at >= 0) picked[at] = alt;
  };
  if (lineup % ALT_EVERY === 0) swap(mains[0]!, alts[0]);
  if (lineup % ALT_EVERY === ALT_EVERY / 2) swap(mains[1]!, alts[1]);
  return picked.map((p, j) => ({ participantId: p.id, team: j < 5 ? "A" : "B", position: POSITIONS[j % 5]! }));
}

interface SeededGroup extends TestGroup {
  viewToken: string;
  inProgressMatchId: string;
}

/** matchTotal경기(가져온 것 + 열린 내전의 것)를 가진 모임을 API로 만든다. */
async function seedGroup(matchTotal: number): Promise<SeededGroup> {
  const g = await setupGroup(MAIN_PLAYERS);
  const mains = g.people;
  const added = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: ["참가자1부캐", "참가자2부캐"] });
  expect(added.status).toBe(200);
  const alts = added.body.participants as [ParticipantView, ParticipantView];

  for (const [name, startsOn, endsOn] of [
    ["2025 겨울", "2025-11-01", "2025-12-31"],
    ["2026 시즌", "2026-01-01", "2026-12-31"],
  ] as const) {
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/seasons`, { name, startsOn, endsOn })).status).toBe(200);
  }

  const importCount = matchTotal - LIVE_CONFIRMED - LIVE_IN_PROGRESS;
  const legacyMatches = Array.from({ length: importCount }, (_, i) => ({
    playedAt: new Date(FIRST_PLAYED_AT + i * PLAY_INTERVAL_MS).toISOString(),
    roster: importedRoster(i, mains, alts),
    winnerTeam: i % 3 === 0 ? "B" : "A",
    winnerSide: "unknown",
  }));
  const batchId = unique("legacy-batch");
  const importedIds: string[] = [];
  for (let from = 0; from < importCount; from += MAX_IMPORT_MATCHES) {
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId,
      matches: legacyMatches.slice(from, from + MAX_IMPORT_MATCHES),
      source: { kind: "legacy", sourceKey: LEGACY_SOURCE_KEY, label: "기존 사이트" },
    });
    if (res.status !== 200) throw new Error(`가져오기 실패: ${JSON.stringify(res.body)}`);
    importedIds.push(...(res.body.matchIds as string[]));
  }

  for (let k = 0; k < 2; k++) {
    const merged = await api(g.cookie, "POST", `/api/groups/${g.gid}/merges`, {
      requestId: requestId(),
      sourceId: alts[k]!.id,
      targetId: mains[k]!.id,
    });
    if (merged.status !== 200) throw new Error(`합치기 실패: ${JSON.stringify(merged.body)}`);
  }

  // 같은 구성이 연달아 붙은 처음 두 묶음을 bo3 시리즈로 묶는다.
  for (let k = 0; k < 2; k++) {
    const created = await api(g.cookie, "POST", `/api/groups/${g.gid}/series`, {
      requestId: requestId(),
      format: "bo3",
      matchIds: importedIds.slice(k * SAME_TEAMS_RUN, (k + 1) * SAME_TEAMS_RUN),
    });
    if (created.status !== 200) throw new Error(`시리즈 실패: ${JSON.stringify(created.body)}`);
  }

  // 열린 내전의 경기마다 10칸씩 밀어 고른다: 순환이 켜져 있어 같은 주기에 서포터를 두 번 시키면 시작이 거절된다.
  const liveRoster = (k: number) => rosterOf(mains.slice(k * 10).concat(mains.slice(0, k * 10)));
  for (let k = 0; k < LIVE_CONFIRMED; k++) await playConfirmed(g, liveRoster(k));
  const live = await start(g, liveRoster(LIVE_CONFIRMED));
  if (live.status !== 200) throw new Error(`시작 실패: ${JSON.stringify(live.body)}`);

  const snap = (await api<Snapshot>(g.cookie, "GET", `/api/groups/${g.gid}/snapshot`)).body;
  return { ...g, viewToken: snap.group.viewToken!, inProgressMatchId: live.body.match.id };
}

/* ------------------------------------------------------------------ */
/* 재기                                                                 */
/* ------------------------------------------------------------------ */

/** snapshotStatements의 순서(snapshot.ts parseSnapshot이 읽는 순서)대로 붙인 짧은 이름. */
const COMMON_STATEMENT_NAMES = [
  "모임 행",
  "설정 버전",
  "참가자(+합치기 대상)",
  "열린 내전",
  "활성 순환 주기",
  "순환 차례 기록",
  "경기",
  "명단",
  "이력: 최근 200",
  "이력: 정정·제외·복구 200",
  "이력: 합치기 묶음",
  "이력: 지운 경기 삭제 줄",
  "시즌",
  "시리즈",
  "시리즈 소속 경기",
];
const OPERATOR_STATEMENT_NAMES = [
  "서포터 보정값",
  "가져오기 묶음 집계",
  "가져오기 출처",
  "합치기 기록",
  "참가자 본인 연결",
  "연결 링크",
  "참가자 요청: 열림",
  "참가자 요청: 처리됨",
];

type StatementReading = {
  문장: string;
  SQL앞부분: string;
  rows_read: number;
  돌려준행: number;
};

/** buildSnapshot과 같은 batch를 돌려 문장별 rows_read를 재고, 결과로 스냅숏도 만들어 돌려준다. */
async function readSnapshotStatements(
  gid: string,
  role: "operator" | "viewer",
): Promise<{ readings: StatementReading[]; total: number; snapshot: Snapshot }> {
  const statements = snapshotStatements(env, gid, role);
  const results = await env.DB.batch(statements);
  const names = role === "operator" ? [...COMMON_STATEMENT_NAMES, ...OPERATOR_STATEMENT_NAMES] : COMMON_STATEMENT_NAMES;
  const readings = results.map((r, i) => {
    const sql = (statements[i] as unknown as { statement?: string }).statement ?? "";
    return {
      문장: names[i] ?? `(이름 없음 ${i})`,
      SQL앞부분: sqlHead(sql).slice(0, 60),
      rows_read: r.meta.rows_read ?? 0,
      돌려준행: r.results.length,
    };
  });
  return {
    readings,
    total: readings.reduce((sum, r) => sum + r.rows_read, 0),
    snapshot: parseSnapshot(role, results),
  };
}

async function bodySize(snapshot: Snapshot): Promise<{ json: number; gzip: number }> {
  const json = new TextEncoder().encode(JSON.stringify(snapshot));
  const gzipped = await new Response(
    new Blob([json]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  return { json: json.byteLength, gzip: gzipped.byteLength };
}

/** Workers 풀에서는 console.table이 아무것도 찍지 않아 열을 " | "로 나눈 줄로 찍는다. */
function printTable(title: string, rows: Record<string, string | number>[]): void {
  const columns = Object.keys(rows[0] ?? {});
  const lines = [columns.join(" | "), ...rows.map((r) => columns.map((c) => String(r[c])).join(" | "))];
  console.log(`\n[${title}]\n${lines.join("\n")}`);
}

/** 304 경로가 쓰는 모임 행 읽기 하나의 rows_read. */
async function headRowsRead(load: (measured: Env) => Promise<unknown>): Promise<number> {
  const { db, tally } = rowsReadingDb(env.DB);
  expect(await load({ ...(env as unknown as Env), DB: db })).not.toBeNull();
  return tally.rowsRead;
}

describe("스냅숏 D1 읽기 행 수 측정", () => {
  it(
    `${BIG_GROUP_MATCHES}경기·${MID_GROUP_MATCHES}경기 모임의 스냅숏·304·결과 저장이 읽는 행 수`,
    { timeout: MEASURE_TIMEOUT_MS },
    async () => {
      const totals: { 경기수: number; 역할: string; rows_read: number; 추정식: number }[] = [];

      const mid = await seedGroup(MID_GROUP_MATCHES);
      for (const role of ["operator", "viewer"] as const) {
        const measured = await readSnapshotStatements(mid.gid, role);
        expect(measured.snapshot.matches).toHaveLength(MID_GROUP_MATCHES);
        totals.push({ 경기수: MID_GROUP_MATCHES, 역할: role, rows_read: measured.total, 추정식: snapshotCost(MID_GROUP_MATCHES) });
      }

      const big = await seedGroup(BIG_GROUP_MATCHES);
      const sizes: { 역할: string; JSON바이트: number; gzip바이트: number }[] = [];
      for (const role of ["operator", "viewer"] as const) {
        const measured = await readSnapshotStatements(big.gid, role);
        expect(measured.total).toBeGreaterThan(0);
        expect(measured.snapshot.matches).toHaveLength(BIG_GROUP_MATCHES);
        printTable(`${BIG_GROUP_MATCHES}경기 ${role} 문장별 rows_read (합계 ${measured.total})`, measured.readings);
        totals.push({ 경기수: BIG_GROUP_MATCHES, 역할: role, rows_read: measured.total, 추정식: snapshotCost(BIG_GROUP_MATCHES) });
        const size = await bodySize(measured.snapshot);
        sizes.push({ 역할: role, JSON바이트: size.json, gzip바이트: size.gzip });
      }
      printTable("경기 수별 합계와 추정식 300 + 16n", totals);
      printTable("응답 본문 크기(buildSnapshot 결과 JSON)", sizes);

      const heads = [
        { 경로: "loadEtagHead 운영자(연결 링크 만료 포함)", rows_read: await headRowsRead((e) => loadEtagHead(e, big.gid)) },
        { 경로: "loadEtagHead 멤버", rows_read: await headRowsRead((e) => loadEtagHead(e, big.gid, false)) },
        { 경로: "loadEtagHeadByViewToken", rows_read: await headRowsRead((e) => loadEtagHeadByViewToken(e, big.viewToken)) },
      ];

      // 요청 전체(인증·요청 수 제한·하루 예산 기록 포함). 200 다음 같은 ETag로 다시 보내 304를 잰다.
      const requests: { 요청: string; 상태: number; 질의: number; rows_read: number; rows_written: number }[] = [];
      const note = (label: string, r: Awaited<ReturnType<typeof measuredRequest>>) =>
        requests.push({ 요청: label, 상태: r.status, 질의: r.tally.queries, rows_read: r.tally.rowsRead, rows_written: r.tally.rowsWritten });
      const operatorPath = `/api/groups/${big.gid}/snapshot`;
      const operatorFull = await measuredRequest("GET", operatorPath, { cookie: big.cookie });
      note("GET 운영자 스냅숏 200", operatorFull);
      note(
        "GET 운영자 스냅숏 304",
        await measuredRequest("GET", operatorPath, { cookie: big.cookie, headers: { "If-None-Match": operatorFull.etag! } }),
      );
      const viewPath = `/api/view/${big.viewToken}`;
      const viewFull = await measuredRequest("GET", viewPath);
      note("GET 조회 링크 200", viewFull);
      note("GET 조회 링크 304", await measuredRequest("GET", viewPath, { headers: { "If-None-Match": viewFull.etag! } }));

      // 결과 저장: 결과를 넣지 않은 경기 하나를 확정한다(상태가 바뀌므로 맨 마지막에 잰다).
      const before = (await readSnapshotStatements(big.gid, "operator")).snapshot;
      const pending = before.matches.find((m) => m.id === big.inProgressMatchId)!;
      const saved = await measuredRequest("POST", `/api/groups/${big.gid}/matches/${pending.id}/result`, {
        cookie: big.cookie,
        body: { requestId: requestId(), baseMatchVersion: pending.version, winnerTeam: "A", winnerSide: "blue" },
      });
      expect(saved.status).toBe(200);
      note("POST 결과 저장", saved);

      printTable("304 경로의 모임 행 읽기", heads);
      printTable("요청 하나 전체(D1 질의 수·읽은 행·쓴 행)", requests);
      printTable(
        `결과 저장이 많이 읽은 문장 상위 ${HEAVIEST_SAVE_STATEMENTS}개`,
        [...saved.tally.perStatement]
          .sort((a, b) => b.rowsRead - a.rowsRead)
          .slice(0, HEAVIEST_SAVE_STATEMENTS)
          .map((s) => ({ rows_read: s.rowsRead, SQL앞부분: s.sql })),
      );
      // 표를 먼저 찍고 단언한다: 깨졌을 때 어느 문장이 많이 읽는지 바로 보이게.
      expect(saved.tally.rowsRead).toBeLessThanOrEqual(SAVE_ROWS_READ_CEILING);
    },
  );

  it(
    `${BIG_GROUP_MATCHES}경기 모임의 시리즈 빼기·넣기, 경기 취소, 합치기가 읽는 행 수`,
    { timeout: MEASURE_TIMEOUT_MS },
    async () => {
      const big = await seedGroup(BIG_GROUP_MATCHES);
      await addOtherGroupsRotation();
      const before = (await readSnapshotStatements(big.gid, "operator")).snapshot;
      const series = before.series![0]!;
      const movedMatchId = series.matchIds[series.matchIds.length - 1]!;

      const requests: { 요청: string; 상태: number; rows_read: number; 살펴볼문장: number }[] = [];
      const statements: { 요청: string; rows_read: number; SQL앞부분: string }[] = [];
      const note = (label: string, r: Awaited<ReturnType<typeof measuredRequest>>, focus: RegExp) => {
        const focused = r.tally.perStatement.filter((s) => focus.test(s.text));
        requests.push({
          요청: label,
          상태: r.status,
          rows_read: r.tally.rowsRead,
          살펴볼문장: focused.reduce((sum, s) => sum + s.rowsRead, 0),
        });
        for (const s of focused) statements.push({ 요청: label, rows_read: s.rowsRead, SQL앞부분: s.sql });
        return r;
      };
      const seriesPath = `/api/groups/${big.gid}/series/${series.id}`;
      const removed = note(
        "POST 시리즈에서 빼기",
        await measuredRequest("POST", `${seriesPath}/remove`, {
          cookie: big.cookie,
          body: { requestId: requestId(), matchId: movedMatchId },
        }),
        SERIES_SQL,
      );
      const added = note(
        "POST 시리즈에 넣기",
        await measuredRequest("POST", `${seriesPath}/add`, {
          cookie: big.cookie,
          body: { requestId: requestId(), matchId: movedMatchId },
        }),
        SERIES_SQL,
      );
      const pending = before.matches.find((m) => m.id === big.inProgressMatchId)!;
      const canceled = note(
        "POST 경기 취소",
        await measuredRequest("POST", `/api/groups/${big.gid}/matches/${pending.id}/cancel`, {
          cookie: big.cookie,
          body: { requestId: requestId(), baseMatchVersion: pending.version },
        }),
        ROTATION_SQL,
      );
      // 경기가 없는 새 참가자를 차례 기록이 있는 사람(열린 내전 두 번째 경기의 서포터)에게 합친다.
      const fresh = await api(big.cookie, "POST", `/api/groups/${big.gid}/participants`, { names: ["합칠사람"] });
      const source = (fresh.body.participants as ParticipantView[]).find((p) => p.name === "합칠사람")!;
      const merged = note(
        "POST 합치기",
        await measuredRequest("POST", `/api/groups/${big.gid}/merges`, {
          cookie: big.cookie,
          body: { requestId: requestId(), sourceId: source.id, targetId: big.people[14]!.id },
        }),
        ROTATION_SQL,
      );
      const rotationReading = (await readSnapshotStatements(big.gid, "operator")).readings.find(
        (r) => r.문장 === "순환 차례 기록",
      )!;

      printTable(`요청 하나 전체와 시리즈·차례 문장의 rows_read (다른 모임 차례 기록 ${OTHER_GROUPS_ROTATION_ROWS}행)`, requests);
      printTable("시리즈·차례 문장별 rows_read", statements);
      printTable("스냅숏의 순환 차례 기록 문장", [rotationReading]);
      for (const r of [removed, added, canceled, merged]) expect(r.status).toBe(200);
      for (const r of [removed, added, canceled]) expect(r.tally.rowsRead).toBeLessThanOrEqual(WRITE_ROWS_READ_CEILING);
      expect(requests.find((r) => r.요청 === "POST 합치기")!.살펴볼문장).toBeLessThanOrEqual(ROTATION_ROWS_READ_CEILING);
      expect(rotationReading.rows_read).toBeLessThanOrEqual(ROTATION_ROWS_READ_CEILING);
    },
  );

  it(`오늘 하루 창 행이 ${TODAY_DAILY_RATE_ROWS}개 있을 때 요청 하나의 요청 수 제한 정리가 읽는 행 수`, async () => {
    const g = await setupGroup(10);
    const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
       INSERT INTO rate_limits (key, window_start, count) SELECT 'day-snapshot-rows-ip:noise' || i, ?1, 1 FROM n`,
    )
      .bind(dayStart, TODAY_DAILY_RATE_ROWS)
      .run();
    // 어제의 하루 창 행과 분 단위 행은 이 요청의 정리가 지워야 한다.
    await env.DB.prepare(
      "INSERT INTO rate_limits (key, window_start, count) VALUES ('day-snapshot-rows-ip:yesterday', ?1, 1), ('view-ip:yesterday', ?2, 1)",
    )
      .bind(dayStart - 86_400_000, dayStart - 60_000)
      .run();
    const r = await measuredRequest("GET", `/api/groups/${g.gid}/snapshot`, { cookie: g.cookie });
    expect(r.status).toBe(200);
    const cleanups = r.tally.perStatement.filter((s) => s.sql.startsWith("DELETE FROM rate_limits"));
    printTable(
      `GET 스냅숏 200의 요청 수 제한 정리 문장 (요청 전체 ${r.tally.rowsRead}행)`,
      cleanups.map((s) => ({ rows_read: s.rowsRead, SQL앞부분: s.sql })),
    );
    const left = await env.DB.prepare(
      `SELECT SUM(key LIKE 'day-snapshot-rows-ip:noise%') AS today, SUM(key LIKE '%:yesterday') AS yesterday FROM rate_limits`,
    ).first<{ today: number; yesterday: number }>();
    // 오늘 하루 창 행은 지우지 않는다(지우면 예산이 초기화된다).
    expect(left).toEqual({ today: TODAY_DAILY_RATE_ROWS, yesterday: 0 });
    expect(cleanups.reduce((sum, s) => sum + s.rowsRead, 0)).toBeLessThanOrEqual(RATE_CLEANUP_ROWS_READ_CEILING);
  });
});

/**
 * 다른 모임들의 서포터 차례 기록을 대신한다: 다른 모임 하나에 실제 경기 하나를 두고 그 두 행을 무효 반복 사건으로 복제한다
 * (무효라 그 모임의 순환에도 영향이 없다).
 */
async function addOtherGroupsRotation(): Promise<void> {
  const other = await setupGroup(10);
  await playConfirmed(other, rosterOf(other.people));
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
     INSERT INTO rotation_events (id, group_id, cycle_id, match_id, participant_id, kind, voided, created_at)
     SELECT e.id || '-' || n.i, e.group_id, e.cycle_id, e.match_id, e.participant_id, 'repeat', 1, e.created_at
     FROM rotation_events e CROSS JOIN n WHERE e.group_id = ?1`,
  )
    .bind(other.gid, OTHER_GROUPS_ROTATION_ROWS / 2)
    .run();
}
