import { afterEach, describe, expect, it } from "vitest";
import { legacyHooks, MAX_LEGACY_BYTES } from "../src/server/legacy";
import { rateClock } from "../src/server/ratelimit";
import { linkNames } from "../src/shared/importLink";
import { convertLegacy, legacySourceKey, type LegacyFutureMode, type LegacyMatch } from "../src/shared/legacy";
import { classifyImport, toSheetPayload, type ExistingImport, type SheetSideMode } from "../src/shared/sheetTable";
import type { Snapshot } from "../src/shared/types";
import { direct } from "./direct";
import { api, login, requestId, setupGroup, snapshot, unique, type TestGroup } from "./helpers";

// 기존 사이트(v1) 기록 가져오기: 읽기 경로의 권한·요청 수 제한·SSRF 방어(가짜 fetch),
// 가져오기 → 다시 가져오기 0건 → 경기 추가 뒤 추가분만 → id 같고 내용 바뀜은 "바뀐 경기", 묶음 제외·복구, 백업 → 복원.

const ID = "AKfycbTestDeploymentIdForIntegration00000000000000";
const SCRIPT_URL = `https://script.google.com/macros/s/${ID}/exec`;
const ECHO_URL = "https://script.googleusercontent.com/macros/echo?user_content_key=abc123&lib=xyz";
const SOURCE_KEY = legacySourceKey(ID);
const NAMES = Array.from({ length: 12 }, (_, i) => `옛선수${String(i + 1).padStart(2, "0")}`);
const DAY = 86_400_000;

const realNow = rateClock.now;
afterEach(() => {
  legacyHooks.fetch = null;
  rateClock.now = realNow;
});

/** 한국 날짜(YYYY-MM-DD)의 정오. */
const kstNoon = (date: string) => Date.parse(`${date}T12:00:00+09:00`);
const kstDate = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

/** n번째 경기: 12명 중 10명, 라인 0~4, 홀수는 블루 승. 하루 3경기씩 dayBase부터. */
function v1Match(no: number, dayBase = "2026-09-01"): LegacyMatch {
  const ten = Array.from({ length: 10 }, (_, k) => NAMES[(no + k) % 12]!);
  return {
    id: `v1-${no}`,
    time: kstNoon(dayBase) + Math.floor((no - 1) / 3) * DAY,
    blue: ten.slice(0, 5).map((name, lane) => ({ name, lane })),
    red: ten.slice(5).map((name, lane) => ({ name, lane })),
    winner: no % 2 === 1 ? "blue" : "red",
    sidesKnown: true,
  };
}
const v1Matches = (count: number) => Array.from({ length: count }, (_, i) => v1Match(i + 1));
const responseBody = (matches: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    revision: 7,
    payload: { matches, resetAt: 1, schemaVersion: 2, auditLog: [], featureOptions: { elite: [] }, trash: [v1Match(99)], ...extra },
  });

type Call = { url: string; method: string; body: string | null; contentType: string | null; redirect: string | undefined };

/** Apps Script 실제 동작: POST /exec → 302 → GET echo → 200 JSON. */
function fakeScript(body: () => Response | string, opts: { first?: () => Response } = {}): Call[] {
  const calls: Call[] = [];
  legacyHooks.fetch = async (url, init) => {
    calls.push({
      url,
      method: String(init.method),
      body: typeof init.body === "string" ? init.body : null,
      contentType: new Headers(init.headers).get("Content-Type"),
      redirect: init.redirect,
    });
    if (url === SCRIPT_URL) {
      if (opts.first) return opts.first();
      return new Response(null, { status: 302, headers: { Location: ECHO_URL } });
    }
    if (url === ECHO_URL) {
      if (init.method !== "GET") return new Response("Length Required", { status: 411 });
      const b = body();
      return typeof b === "string" ? new Response(b, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }) : b;
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return calls;
}

async function read(g: TestGroup, url = SCRIPT_URL, overrides = {}) {
  const res = await direct(overrides, "POST", `/api/groups/${g.gid}/legacy/read`, { cookie: g.cookie, body: { url } });
  return { status: res.status, body: (await res.json()) as any };
}

describe("기존 사이트 읽기 경로", () => {
  it("배포 ID로 조립한 주소에 읽기만 보내고(암호 없음), 302 뒤에는 GET으로 받아 검증한 경기만 돌려준다", async () => {
    const g = await setupGroup(0);
    const calls = fakeScript(() => responseBody(v1Matches(3)));
    const res = await read(g, `script.google.com/macros/s/${ID}/exec?password=x#y`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.sourceKey).toBe(SOURCE_KEY);
    expect(res.body.matches).toHaveLength(3);
    expect(Object.keys(res.body.matches[0]).sort()).toEqual(["blue", "id", "red", "sidesKnown", "time", "winner"]);
    expect(res.body.summary).toMatchObject({ matches: 3, trash: 1 });
    expect(res.body.remembered).toBeNull();
    expect(calls.map((c) => [c.url, c.method, c.redirect])).toEqual([
      [SCRIPT_URL, "POST", "manual"],
      [ECHO_URL, "GET", "manual"],
    ]);
    expect(JSON.parse(calls[0]!.body!)).toEqual({ action: "read" });
    expect(calls[0]!.contentType).toBe("text/plain;charset=utf-8");
    expect(calls[1]!.body).toBeNull();
  });

  it("운영자만 읽을 수 있다(로그인 안 함 401, 다른 모임 운영자 404). 바깥 요청은 나가지 않는다", async () => {
    const g = await setupGroup(0);
    const other = await setupGroup(0);
    const calls = fakeScript(() => responseBody([]));
    expect((await direct({}, "POST", `/api/groups/${g.gid}/legacy/read`, { body: { url: SCRIPT_URL } })).status).toBe(401);
    expect((await read({ ...g, cookie: other.cookie })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("Apps Script 주소가 아니면 바깥에 요청하지 않는다", async () => {
    const g = await setupGroup(0);
    const calls = fakeScript(() => responseBody([]));
    for (const url of [
      "https://evil.example/macros/s/" + ID + "/exec",
      "http://169.254.169.254/latest/meta-data",
      `https://script.google.com.evil.example/macros/s/${ID}/exec`,
      "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
    ]) {
      const res = await read(g, url);
      expect(res.status, url).toBe(400);
      expect(res.body.error.code).toBe("LEGACY_URL_INVALID");
    }
    expect(calls).toHaveLength(0);
  });

  it("Apps Script 밖으로 보내는 리디렉션은 따라가지 않고, 3번까지만 따라간다", async () => {
    const g = await setupGroup(0);
    for (const location of [
      "https://evil.example/steal",
      "http://script.googleusercontent.com/x",
      "https://doc-1.googleusercontent.com/x",
      "https://script.googleusercontent.com.evil.net/x",
      "https://script.googleusercontent.com:444/x",
      "https://docs.google.com/x",
    ]) {
      const calls = fakeScript(() => responseBody([]), { first: () => new Response(null, { status: 302, headers: { Location: location } }) });
      const res = await read(g);
      expect(res.status, location).toBe(400);
      expect(res.body.error.code, location).toBe("LEGACY_UNREACHABLE");
      expect(calls).toHaveLength(1);
    }
    const loop = `${ECHO_URL}&loop=1`;
    const calls: string[] = [];
    legacyHooks.fetch = async (url) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { Location: loop } });
    };
    expect((await read(g)).body.error.code).toBe("LEGACY_UNREACHABLE");
    expect(calls).toHaveLength(4);
  });

  it("307은 POST를 그대로, 302·303은 GET으로 따라간다", async () => {
    const g = await setupGroup(0);
    const seen: string[] = [];
    legacyHooks.fetch = async (url, init) => {
      seen.push(`${init.method} ${url === SCRIPT_URL ? "exec" : url.includes("a=1") ? "a" : "b"}`);
      if (url === SCRIPT_URL) return new Response(null, { status: 307, headers: { Location: `${ECHO_URL}&a=1` } });
      if (url.includes("a=1")) return new Response(null, { status: 303, headers: { Location: `${ECHO_URL}&b=1` } });
      return new Response(responseBody([]), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    expect((await read(g)).status).toBe(200);
    expect(seen).toEqual(["POST exec", "POST a", "GET b"]);
  });

  it("웹 앱이 공개가 아니면(로그인 화면·HTML·401) 액세스 권한을 확인하라고 안내한다", async () => {
    const g = await setupGroup(0);
    const htmlPage = () => new Response("<!DOCTYPE html><html>로그인</html>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    const cases: [string, () => Response][] = [
      ["로그인 리디렉션", () => new Response(null, { status: 302, headers: { Location: "https://accounts.google.com/ServiceLogin?continue=x" } })],
      ["200 HTML", htmlPage],
      ["401", () => new Response("no", { status: 401, headers: { "Content-Type": "text/html" } })],
    ];
    for (const [label, first] of cases) {
      fakeScript(() => responseBody([]), { first });
      const res = await read(g);
      expect(res.body.error.code, label).toBe("LEGACY_NOT_PUBLIC");
      expect(res.body.error.message).toContain("모든 사용자");
    }
    fakeScript(htmlPage);
    expect((await read(g)).body.error.code).toBe("LEGACY_NOT_PUBLIC");
  });

  it("10MB를 넘으면 받지 않는다(Content-Length가 있든 없든)", async () => {
    const g = await setupGroup(0);
    fakeScript(() => new Response("{}", { status: 200, headers: { "Content-Type": "application/json", "Content-Length": String(MAX_LEGACY_BYTES + 1) } }));
    const declared = await read(g);
    expect(declared.status).toBe(413);
    expect(declared.body.error.code).toBe("LEGACY_TOO_LARGE");
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 30) controller.close();
        else controller.enqueue(chunk);
      },
    });
    fakeScript(() => new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } }));
    expect((await read(g)).status).toBe(413);
    expect(sent).toBeLessThanOrEqual(13);
  });

  it("JSON이 아니거나, 읽기를 거절했거나, v1 형식이 깨졌으면 아무것도 돌려주지 않는다", async () => {
    const g = await setupGroup(0);
    fakeScript(() => new Response("a,b", { status: 200, headers: { "Content-Type": "text/csv" } }));
    expect((await read(g)).body.error.code).toBe("LEGACY_NOT_JSON");
    fakeScript(() => "not json");
    expect((await read(g)).body.error.code).toBe("LEGACY_NOT_JSON");
    fakeScript(() => JSON.stringify({ ok: false, error: "x" }));
    expect((await read(g)).body.error.code).toBe("LEGACY_REFUSED");
    const broken = v1Matches(3);
    broken[1]!.blue[0]!.lane = 7;
    fakeScript(() => responseBody(broken));
    const res = await read(g);
    expect(res.body.error.code).toBe("LEGACY_BAD_FORMAT");
    expect(res.body.error.message).toContain("2번째 경기");
    expect(res.body.matches).toBeUndefined();
  });

  it("바깥 요청 한도(시트 읽기와 같은 계정당 한도)가 걸린다", async () => {
    let now = Math.floor(Date.now() / 60_000) * 60_000 + 30 * 60_000 + 1000;
    rateClock.now = () => now;
    const g = await setupGroup(0);
    fakeScript(() => responseBody([]));
    const limits = { RATE_SHEET_PER_ACCOUNT: "2", RATE_SHEET_PER_IP: "50" };
    expect((await read(g, SCRIPT_URL, limits)).status).toBe(200);
    expect((await read(g, SCRIPT_URL, limits)).status).toBe(200);
    const over = await read(g, SCRIPT_URL, limits);
    expect(over.status).toBe(429);
    now += 60_000;
    expect((await read(g, SCRIPT_URL, limits)).status).toBe(200);
  });

  it("테스트 전용 응답 등록은 운영 설정에서 404이고, 가짜 로그인 환경에서만 바깥 요청 대신 쓰인다", async () => {
    // 다른 테스트와 겹치지 않게 다른 배포 ID로 등록한다(등록은 서버 메모리에 남는다).
    const fixtureUrl = SCRIPT_URL.replace("Integration", "FixtureOnly0");
    const cookie = await login();
    const body = { url: fixtureUrl, json: responseBody(v1Matches(2)) };
    expect((await direct({ AUTH_MODE: "oauth" }, "POST", "/api/test/legacy-fixture", { cookie, body })).status).toBe(404);
    expect((await direct({ DEPLOY_ENV: "production" }, "POST", "/api/test/legacy-fixture", { cookie, body })).status).not.toBe(200);
    const g = await setupGroup(0);
    expect((await direct({}, "POST", "/api/test/legacy-fixture", { cookie: g.cookie, body })).status).toBe(200);
    const calls = fakeScript(() => responseBody([]));
    const res = await read(g, fixtureUrl);
    expect(res.body.matches).toHaveLength(2);
    expect(calls).toHaveLength(0);
    const prod = await read(g, fixtureUrl, { AUTH_MODE: "oauth" });
    expect(prod.status).toBe(401); // 운영 설정에서는 가짜 로그인 세션도 받지 않는다.
  });
});

/* ------------------------------------------------------------------ */
/* 가져오기 → 다시 가져오기                                              */
/* ------------------------------------------------------------------ */

async function fingerprints(g: TestGroup): Promise<ExistingImport[]> {
  return (await api(g.cookie, "GET", `/api/groups/${g.gid}/imports/fingerprints`)).body.imports;
}

/** 화면이 하는 일 그대로: 읽기 → 바꾸기 → 분류 → 이름 연결 → 50경기씩 넣기(출처: 기존 사이트). */
async function importLegacy(
  g: TestGroup,
  matches: LegacyMatch[],
  options: { futureMode?: LegacyFutureMode; from?: string | null; side?: SheetSideMode; includeChanged?: boolean; batchId?: string } = {},
) {
  fakeScript(() => responseBody(matches));
  const res = await read(g);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const futureMode = options.futureMode ?? "shift";
  const conv = convertLegacy(res.body.matches, { timeZone: "Asia/Seoul", now: Date.now(), futureMode, from: options.from ?? null });
  expect(conv.errors).toEqual([]);
  const result = classifyImport(conv.matches, await fingerprints(g), res.body.sourceKey);
  const toSend = [...result.fresh, ...(options.includeChanged ? result.changed.map((c) => c.match) : [])].sort((x, y) => x.line - y.line);
  const snap = await snapshot(g);
  const links = linkNames(conv.names, snap.participants);
  const idOf = new Map(links.filter((l) => l.participantId).map((l) => [l.name, l.participantId!]));
  const newNames = links.filter((l) => l.kind === "new").map((l) => l.name);
  if (newNames.length > 0) {
    const made = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: newNames });
    newNames.forEach((n, i) => idOf.set(n, made.body.participants[i].id));
  }
  const payload = toSheetPayload(toSend, (n) => idOf.get(n)!, options.side ?? "column", "Asia/Seoul");
  const batchId = options.batchId ?? unique("batch");
  const source = {
    kind: "legacy",
    sourceKey: res.body.sourceKey,
    label: "기존 사이트",
    ...(conv.affected.count > 0 ? { options: { futureMode, from: options.from ?? conv.affected.first } } : {}),
  };
  for (let i = 0; i < payload.length; i += 50) {
    const r = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId,
      source,
      matches: payload.slice(i, i + 50),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return { result, conv, batchId, sent: payload.length, remembered: res.body.remembered };
}

const imported = (s: Snapshot) => s.matches.filter((m) => m.source === "import");

describe("기존 사이트 가져오기 → 다시 가져오기", () => {
  it("가져오기(50경기 묶음) → 다시 가져오기 0건 → 경기 추가 뒤 추가분만 → 같은 id인데 내용이 바뀐 경기는 따로", async () => {
    const g = await setupGroup(0);
    const first = await importLegacy(g, v1Matches(60));
    expect(first.sent).toBe(60);
    let snap = await snapshot(g);
    expect(imported(snap)).toHaveLength(60);
    expect(snap.importBatches).toHaveLength(1);
    expect(snap.importBatches![0]).toMatchObject({ kind: "legacy", label: "기존 사이트", count: 60 });
    // 배포 ID(출처 열쇠)는 조회 응답에 나가지 않는다.
    expect(JSON.stringify(snap)).not.toContain(ID);
    // 같은 날 경기는 v1 순서대로 정오 + 1초씩.
    const day1 = imported(snap).filter((m) => kstDate(Date.parse(m.playedAt)) === "2026-09-01").map((m) => m.playedAt).sort();
    expect(day1).toEqual(["2026-09-01T03:00:00.000Z", "2026-09-01T03:00:01.000Z", "2026-09-01T03:00:02.000Z"]);
    // 블루·레드 그대로: 홀수 경기(블루 승) 30, 레드 승 30.
    const blueWins = imported(snap).filter((m) => (m.teamASide === "blue") === (m.winnerTeam === "A")).length;
    expect(blueWins).toBe(30);

    expect((await importLegacy(g, v1Matches(60))).sent).toBe(0);

    const grown = [...v1Matches(60), v1Match(61), v1Match(62)];
    const second = await importLegacy(g, grown);
    expect([second.result.already.length, second.sent]).toEqual([60, 2]);

    const edited = v1Matches(62);
    edited[4] = { ...edited[4]!, winner: edited[4]!.winner === "blue" ? "red" : "blue" };
    const third = await importLegacy(g, edited);
    expect(third.sent).toBe(0);
    expect(third.result.changed).toHaveLength(1);
    expect(third.result.changed[0]!.match.id).toBe("v1-5");
    snap = await snapshot(g);
    expect(imported(snap)).toHaveLength(62);
  });

  it("진영 미상으로 넣으면 진영 통계에서 빠지고, 붙여 넣기·시트로 넣은 같은 경기와 겹치지 않는다", async () => {
    const g = await setupGroup(0);
    await importLegacy(g, v1Matches(4), { side: "unknown" });
    const snap = await snapshot(g);
    expect(imported(snap).every((m) => m.teamASide === "unknown" || m.teamASide === null)).toBe(true);
    // 지문 없이 들어간 같은 경기(붙여 넣기 예전 방식)가 있어도 지문 계산으로 0건.
    const g2 = await setupGroup(0);
    const people = new Map<string, string>();
    const made = await api(g2.cookie, "POST", `/api/groups/${g2.gid}/participants`, { names: NAMES });
    NAMES.forEach((n, i) => people.set(n, made.body.participants[i].id));
    const conv = convertLegacy(v1Matches(4), { timeZone: "Asia/Seoul", now: Date.now(), futureMode: "shift", from: null });
    const plain = toSheetPayload(conv.matches, (n) => people.get(n)!, "unknown", "Asia/Seoul").map(({ fingerprint: _f, rowKey: _r, ...m }) => m);
    expect((await api(g2.cookie, "POST", `/api/groups/${g2.gid}/matches/import`, { requestId: requestId(), batchId: unique("b"), matches: plain })).status).toBe(200);
    expect((await importLegacy(g2, v1Matches(4))).sent).toBe(0);
  });

  it("미래 날짜를 한 해 앞으로 옮겨 넣으면 고른 기준이 묶음에 남고, 같은 주소로 다시 읽으면 그 기준을 돌려준다(0건)", async () => {
    const g = await setupGroup(0);
    const soon = kstDate(Date.now() + 20 * DAY);
    const later = kstDate(Date.now() + 40 * DAY);
    const ms = [...v1Matches(3), { ...v1Match(4), time: kstNoon(soon) }, { ...v1Match(5), time: kstNoon(later) }];
    // 옮기지 않고 그대로 보내면 서버가 거절한다(FUTURE_MATCH 유지).
    const people = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: NAMES });
    const idOf = new Map<string, string>(NAMES.map((n, i) => [n, people.body.participants[i].id]));
    // 아직 오지 않은 경기가 없는 것처럼(먼 미래를 지금으로) 바꿔 옮기지 않은 그대로의 날짜를 만든다.
    const raw = convertLegacy(ms, { timeZone: "Asia/Seoul", now: Date.now() + 400 * DAY, futureMode: "shift", from: null });
    const future = toSheetPayload(raw.matches.slice(-1), (n) => idOf.get(n)!, "unknown", "Asia/Seoul");
    const rejected = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, { requestId: requestId(), batchId: unique("b"), matches: future });
    expect(rejected.body.error.code).toBe("FUTURE_MATCH");

    const first = await importLegacy(g, ms, { futureMode: "shift" });
    expect(first.sent).toBe(5);
    expect(first.conv.shiftedRange.first).toBe(`${Number(soon.slice(0, 4)) - 1}${soon.slice(4)}`);
    const again = await importLegacy(g, ms, { futureMode: "shift", from: soon });
    expect(again.remembered).toEqual({ futureMode: "shift", from: soon });
    expect(again.sent).toBe(0);
    // 다른 선택(빼기)으로 읽어도 이미 들어간 경기만 남아 0건.
    expect((await importLegacy(g, ms, { futureMode: "drop" })).sent).toBe(0);
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    expect(backup.importBatches.find((b: any) => b.options)).toMatchObject({ kind: "legacy", sourceKey: SOURCE_KEY, options: { futureMode: "shift", from: soon } });
  });

  it("묶음 단위 전적 제외·복구, 백업 → 복원(같은 모임·새 모임) 뒤에도 출처·줄 위치·중복 방지가 유지되고 모임 삭제로 지워진다", async () => {
    const g = await setupGroup(0);
    const { batchId } = await importLegacy(g, v1Matches(6));
    const off = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/${batchId}`, { requestId: requestId(), exclude: true });
    expect(off.body.changed).toBe(6);
    const on = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/${batchId}`, { requestId: requestId(), exclude: false });
    expect(on.body.changed).toBe(6);

    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    expect(backup.importBatches[0]).toMatchObject({ kind: "legacy", sourceKey: SOURCE_KEY, label: "기존 사이트", options: null });
    expect(backup.matches.every((m: any) => /^v1id:[0-9a-f]{16}$/.test(m.importRowKey))).toBe(true);

    await importLegacy(g, v1Matches(8));
    const snap = await snapshot(g);
    const restored = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: snap.group.generation,
      backup,
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    const after = await importLegacy(g, v1Matches(8));
    expect([after.result.already.length, after.sent]).toEqual([6, 2]);

    const cookie = await login();
    const created = await api(cookie, "POST", "/api/restore/new-group", { requestId: requestId(), confirm: "복원", backup });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const ng: TestGroup = { cookie, gid: created.body.groupId, people: [] };
    expect((await snapshot(ng)).importBatches?.[0]).toMatchObject({ kind: "legacy", count: 6 });
    expect((await fingerprints(ng)).every((f) => f.sourceKey === SOURCE_KEY)).toBe(true);
    expect((await importLegacy(ng, v1Matches(6))).sent).toBe(0);

    const del = await api(ng.cookie, "POST", `/api/groups/${ng.gid}/delete`, { confirm: "삭제" });
    expect(del.status).toBe(200);
    const { env } = await import("cloudflare:test");
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM import_batches WHERE group_id = ?1").bind(ng.gid).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("출처·줄 위치 형식이 틀리면 거절한다", async () => {
    const g = await setupGroup(0);
    const people = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: NAMES });
    const idOf = new Map<string, string>(NAMES.map((n, i) => [n, people.body.participants[i].id]));
    const conv = convertLegacy([v1Match(1)], { timeZone: "Asia/Seoul", now: Date.now(), futureMode: "shift", from: null });
    const [m] = toSheetPayload(conv.matches, (n) => idOf.get(n)!, "unknown", "Asia/Seoul");
    const send = (source: unknown, match = m) =>
      api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, { requestId: requestId(), batchId: unique("b"), source, matches: [match] });
    expect((await send({ kind: "legacy", sourceKey: "sheet:x:0" })).status).toBe(400);
    expect((await send({ kind: "legacy", sourceKey: SOURCE_KEY, options: { futureMode: "move", from: null } })).status).toBe(400);
    expect((await send({ kind: "sheet", sourceKey: `sheet:${"a".repeat(30)}:0`, options: { futureMode: "shift", from: null } })).status).toBe(400);
    expect((await send({ kind: "legacy", sourceKey: SOURCE_KEY }, { ...m!, rowKey: "v1id:xyz" })).status).toBe(400);
    expect((await send({ kind: "legacy", sourceKey: SOURCE_KEY })).status).toBe(200);
  });
});
