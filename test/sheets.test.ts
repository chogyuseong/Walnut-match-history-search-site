import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { rateClock } from "../src/server/ratelimit";
import { fixturesEnabled, MAX_SHEET_BYTES, sheetHooks } from "../src/server/sheets";
import { parseDelimited } from "../src/shared/csv";
import { linkNames } from "../src/shared/importLink";
import { classifyImport, detectMapping, parseSheet, toSheetPayload, type ExistingImport } from "../src/shared/sheetTable";
import type { Snapshot } from "../src/shared/types";
import { direct } from "./direct";
import { api, login, matchAction, requestId, setupGroup, snapshot, start, rosterOf, unique, type TestGroup } from "./helpers";

// 구글 시트에서 가져오기(작업 F): 시트 읽기 경로의 권한·요청 수 제한·SSRF 방어, 가져오기 → 다시 가져오기.

const DOC = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=0`;
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${DOC}/export?format=csv&gid=0`;
const CONTENT_URL = "https://doc-08-4o-sheets.googleusercontent.com/export/abc/def/1/2/*/" + DOC + "?format=csv&gid=0";
const SOURCE_KEY = `sheet:${DOC}:0`;

const realNow = rateClock.now;
afterEach(() => {
  sheetHooks.fetch = null;
  rateClock.now = realNow;
});

type Call = { url: string; redirect: string | undefined };

/** 주소별 가짜 응답. 호출 기록을 남긴다. */
function fakeGoogle(routes: Record<string, () => Response>): Call[] {
  const calls: Call[] = [];
  sheetHooks.fetch = async (url, init) => {
    calls.push({ url, redirect: init.redirect });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route();
  };
  return calls;
}

const redirect = (location: string, status = 307) => () =>
  new Response(null, { status, headers: { Location: location, "Content-Type": "application/binary" } });
const csvResponse = (body: string | ReadableStream, headers: Record<string, string> = {}) => () =>
  new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="x.csv"; filename*=UTF-8''${encodeURIComponent("내전 기록 - 2026.csv")}`,
      ...headers,
    },
  });
const html = (status: number) => () =>
  new Response("<!DOCTYPE html><html>로그인</html>", { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

async function read(g: TestGroup, url = SHEET_URL, overrides: Partial<Env> = {}) {
  const res = await direct(overrides, "POST", `/api/groups/${g.gid}/sheets/read`, { cookie: g.cookie, body: { url } });
  return { status: res.status, body: (await res.json()) as any };
}

describe("시트 읽기 경로", () => {
  it("공개 시트: 조립한 export 주소로 요청하고 구글 리디렉션을 수동으로 따라가 CSV와 제목을 돌려준다", async () => {
    const g = await setupGroup(0);
    const calls = fakeGoogle({ [EXPORT_URL]: redirect(CONTENT_URL), [CONTENT_URL]: csvResponse("﻿날짜,이름\r\n2026-11-05,가람\r\n") });
    const res = await read(g);
    expect(res.status).toBe(200);
    expect(res.body.csv).toContain("2026-11-05,가람");
    expect(res.body.title).toBe("내전 기록 - 2026");
    expect(res.body.sourceKey).toBe(SOURCE_KEY);
    expect(calls.map((c) => c.url)).toEqual([EXPORT_URL, CONTENT_URL]);
    expect(calls.every((c) => c.redirect === "manual")).toBe(true);
  });

  it("운영자만 읽을 수 있다(로그인 안 함 401, 다른 모임 운영자 404). 바깥 요청은 나가지 않는다", async () => {
    const g = await setupGroup(0);
    const other = await setupGroup(0);
    const calls = fakeGoogle({});
    const anon = await direct({}, "POST", `/api/groups/${g.gid}/sheets/read`, { body: { url: SHEET_URL } });
    expect(anon.status).toBe(401);
    const foreign = await read({ ...g, cookie: other.cookie });
    expect(foreign.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("주소가 구글 시트가 아니면 바깥에 요청하지 않고 고칠 방법을 알려준다", async () => {
    const g = await setupGroup(0);
    const calls = fakeGoogle({});
    for (const url of ["https://evil.example/spreadsheets/d/" + DOC, "http://169.254.169.254/latest/meta-data", "https://docs.google.com/spreadsheets/d/x"]) {
      const res = await read(g, url);
      expect(res.status, url).toBe(400);
      expect(res.body.error.code).toBe("SHEET_URL_INVALID");
    }
    expect(calls).toHaveLength(0);
  });

  it("구글 밖으로 보내는 리디렉션은 따라가지 않는다", async () => {
    const g = await setupGroup(0);
    // 검토 L4: 시트와 상관없는 구글 하위 도메인(사용자가 내용을 올릴 수 있는 곳)도 따라가지 않는다.
    for (const location of ["https://evil.example/steal", "http://doc-1.googleusercontent.com/x", "https://googleusercontent.com.evil.net/x", "https://doc-1.googleusercontent.com:444/x", "https://sites.google.com/view/x/data.csv", "https://script.google.com/macros/s/x/exec", "https://www.google.com/url?q=https://evil.example"]) {
      const calls = fakeGoogle({ [EXPORT_URL]: redirect(location) });
      const res = await read(g);
      expect(res.status, location).toBe(400);
      expect(res.body.error.code).toBe("SHEET_UNREACHABLE");
      expect(calls).toHaveLength(1);
    }
  });

  it("리디렉션은 3번까지만 따라간다", async () => {
    const g = await setupGroup(0);
    const hop = (n: number) => `https://doc-${n}.googleusercontent.com/x`;
    const calls = fakeGoogle({
      [EXPORT_URL]: redirect(hop(1)),
      [hop(1)]: redirect(hop(2)),
      [hop(2)]: redirect(hop(3)),
      [hop(3)]: redirect(hop(4)),
      [hop(4)]: csvResponse("a"),
    });
    const res = await read(g);
    expect(res.body.error.code).toBe("SHEET_UNREACHABLE");
    expect(calls).toHaveLength(4);
  });

  it("비공개 시트(401·403·로그인 리디렉션·200 HTML)는 공유 설정을 바꾸거나 붙여 넣으라고 안내한다", async () => {
    const g = await setupGroup(0);
    const cases: Record<string, () => Response> = {
      "401": html(401),
      "403": html(403),
      login: redirect("https://accounts.google.com/ServiceLogin?continue=x", 302),
      "200 html": html(200),
    };
    for (const [label, response] of Object.entries(cases)) {
      fakeGoogle({ [EXPORT_URL]: response });
      const res = await read(g);
      expect(res.status, label).toBe(400);
      expect(res.body.error.code, label).toBe("SHEET_PRIVATE");
      expect(res.body.error.message).toContain("링크가 있는 모든 사용자");
      expect(res.body.error.message).toContain("붙여 넣어");
    }
  });

  it("없는 시트는 404, 없는 탭(gid)은 400으로 구분한다", async () => {
    const g = await setupGroup(0);
    fakeGoogle({ [EXPORT_URL]: html(404) });
    expect((await read(g)).body.error.code).toBe("SHEET_NOT_FOUND");
    fakeGoogle({ [EXPORT_URL]: redirect(CONTENT_URL), [CONTENT_URL]: html(400) });
    const badTab = await read(g);
    expect(badTab.body.error.code).toBe("SHEET_BAD_TAB");
    expect(badTab.body.error.message).toContain("탭");
  });

  it("2MB를 넘으면 받지 않는다(Content-Length가 있든 없든)", async () => {
    const g = await setupGroup(0);
    fakeGoogle({ [EXPORT_URL]: csvResponse("a", { "Content-Length": String(MAX_SHEET_BYTES + 1) }) });
    const declared = await read(g);
    expect(declared.status).toBe(413);
    expect(declared.body.error.code).toBe("SHEET_TOO_LARGE");

    const chunk = new Uint8Array(256 * 1024).fill(0x61);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 20) controller.close();
        else controller.enqueue(chunk);
      },
    });
    fakeGoogle({ [EXPORT_URL]: csvResponse(stream) });
    const streamed = await read(g);
    expect(streamed.status).toBe(413);
    // 상한을 넘자마자 멈춘다(5MB를 다 받지 않는다).
    expect(sent).toBeLessThanOrEqual(10);
  });

  it("CSV가 아닌 응답은 받지 않는다", async () => {
    const g = await setupGroup(0);
    fakeGoogle({ [EXPORT_URL]: () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }) });
    expect((await read(g)).body.error.code).toBe("SHEET_NOT_CSV");
  });

  it("바깥 요청이 실패하면(연결 오류) 다시 시도하거나 붙여 넣으라고 안내한다", async () => {
    const g = await setupGroup(0);
    sheetHooks.fetch = async () => {
      throw new TypeError("network");
    };
    const res = await read(g);
    expect(res.body.error.code).toBe("SHEET_UNREACHABLE");
  });

  it("시트 읽기는 쓰기 한도와 별도로 계정당 한도가 있다", async () => {
    let now = Math.floor(Date.now() / 60_000) * 60_000 + 20 * 60_000 + 1000;
    rateClock.now = () => now;
    const g = await setupGroup(0);
    fakeGoogle({ [EXPORT_URL]: redirect(CONTENT_URL), [CONTENT_URL]: csvResponse("a,b") });
    const limits = { RATE_SHEET_PER_ACCOUNT: "2", RATE_SHEET_PER_IP: "50" };
    expect((await read(g, SHEET_URL, limits)).status).toBe(200);
    expect((await read(g, SHEET_URL, limits)).status).toBe(200);
    const over = await read(g, SHEET_URL, limits);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("RATE_LIMITED");
    now += 60_000;
    expect((await read(g, SHEET_URL, limits)).status).toBe(200);
  });
});

describe("테스트 전용 시트 내용(e2e)", () => {
  it("가짜 로그인 환경에서만 켜지고 운영 설정에서는 꺼진다", () => {
    expect(fixturesEnabled({ AUTH_MODE: "fake", DEPLOY_ENV: "local" } as Env)).toBe(true);
    expect(fixturesEnabled({ AUTH_MODE: "fake", DEPLOY_ENV: "production" } as Env)).toBe(false);
    expect(fixturesEnabled({ AUTH_MODE: "oauth", DEPLOY_ENV: "local" } as Env)).toBe(false);
    expect(fixturesEnabled({ AUTH_MODE: "oauth", DEPLOY_ENV: "production" } as Env)).toBe(false);
  });

  it("운영 설정에서는 등록 경로가 404이고, 등록해 둔 내용도 쓰이지 않는다", async () => {
    const cookie = await login();
    const body = { url: SHEET_URL, csv: "고정,내용" };
    const prod = await direct({ AUTH_MODE: "oauth" }, "POST", "/api/test/sheet-fixture", { cookie, body });
    expect(prod.status).toBe(404);
    const prodFake = await direct({ DEPLOY_ENV: "production" }, "POST", "/api/test/sheet-fixture", { cookie, body });
    expect(prodFake.status).not.toBe(200);

    // 가짜 로그인 환경에서 등록하면 그 시트 주소는 바깥에 요청하지 않고 등록한 내용을 돌려준다.
    const g = await setupGroup(0);
    const local = await direct({}, "POST", "/api/test/sheet-fixture", { cookie: g.cookie, body });
    expect(local.status).toBe(200);
    const calls = fakeGoogle({});
    const res = await read(g);
    expect(res.body.csv).toBe("고정,내용");
    expect(calls).toHaveLength(0);
    // 다른 시트 주소는 등록 내용과 상관없이 바깥에 요청한다.
    const other = `https://docs.google.com/spreadsheets/d/${DOC}/edit#gid=5`;
    const otherExport = `https://docs.google.com/spreadsheets/d/${DOC}/export?format=csv&gid=5`;
    const calls2 = fakeGoogle({ [otherExport]: html(401) });
    expect((await read(g, other)).body.error.code).toBe("SHEET_PRIVATE");
    expect(calls2).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* 가져오기 → 다시 가져오기                                              */
/* ------------------------------------------------------------------ */

const NAMES = Array.from({ length: 12 }, (_, i) => `참가자${i + 1}`);
const LANES = ["TOP", "JG", "MID", "ADC", "SUP"];

/** 한 줄 = 선수 한 명 모양의 시트. n번째 경기는 12명 중 10명, 짝수 경기는 A 승. */
function sheetCsv(count: number, edit?: (no: number, rows: string[][]) => void): string {
  const lines: string[][] = [["경기", "날짜", "팀", "닉네임", "라인", "승패"]];
  for (let no = 1; no <= count; no++) {
    const ten = Array.from({ length: 10 }, (_, k) => NAMES[(no + k) % 12]!);
    const winA = no % 2 === 0;
    const day = `10/${String(1 + Math.floor((no - 1) / 3)).padStart(2, "0")}`; // 연도 없는 날짜, 하루 3경기
    const rows = ten.map((name, k) => [String(no), k === 0 ? day : "", k < 5 ? "A" : "B", name, LANES[k % 5]!, (k < 5) === winA ? "승" : "패"]);
    edit?.(no, rows);
    lines.push(...rows);
  }
  return lines.map((l) => l.join(",")).join("\r\n");
}

async function fingerprints(g: TestGroup): Promise<ExistingImport[]> {
  return (await api(g.cookie, "GET", `/api/groups/${g.gid}/imports/fingerprints`)).body.imports;
}

/** 화면이 하는 일을 그대로: 읽기 → 열 맞추기 → 분류 → 이름 연결 → 50경기씩 넣기. */
async function importSheet(g: TestGroup, csv: string, options: { batchId?: string; includeChanged?: boolean } = {}) {
  const rows = parseDelimited(csv);
  const parsed = parseSheet(rows, { ...detectMapping(rows), year: 2026 }, { today: "2026-11-05" });
  expect(parsed.errors).toEqual([]);
  const result = classifyImport(parsed.matches, await fingerprints(g), SOURCE_KEY);
  const toSend = [...result.fresh, ...(options.includeChanged ? result.changed.map((c) => c.match) : [])];
  const snap = await snapshot(g);
  const links = linkNames(parsed.names, snap.participants);
  const idOf = new Map(links.filter((l) => l.participantId).map((l) => [l.name, l.participantId!]));
  const newNames = links.filter((l) => l.kind === "new").map((l) => l.name);
  if (newNames.length > 0) {
    const made = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: newNames });
    newNames.forEach((n, i) => idOf.set(n, made.body.participants[i].id));
  }
  const payload = toSheetPayload(toSend, (n) => idOf.get(n)!, "a-blue", "Asia/Seoul");
  const batchId = options.batchId ?? unique("batch");
  for (let i = 0; i < payload.length; i += 50) {
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId,
      source: { kind: "sheet", sourceKey: SOURCE_KEY, label: "내전 기록 - 2026" },
      matches: payload.slice(i, i + 50),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return { result, batchId, sent: payload.length };
}

const imported = (s: Snapshot) => s.matches.filter((m) => m.source === "import");

describe("구글 시트 가져오기 → 다시 가져오기", () => {
  it("가져오기 → 다시 가져오기(0건) → 줄 추가 뒤(추가분만) → 고친 줄은 따로, 순환·세션 불변", async () => {
    const g = await setupGroup(12);
    await start(g, rosterOf(g.people));
    const before = await snapshot(g);

    const first = await importSheet(g, sheetCsv(60));
    expect(first.sent).toBe(60);
    let snap = await snapshot(g);
    expect(imported(snap)).toHaveLength(60);
    // 라인이 함께 들어간다.
    expect(imported(snap).every((m) => m.roster.every((r) => r.position !== null))).toBe(true);
    expect(snap.importBatches?.[0]).toMatchObject({ count: 60, kind: "sheet", label: "내전 기록 - 2026" });
    // 서포터 순환·세션·진행 상태는 그대로다.
    expect(snap.rotation).toEqual(before.rotation);
    expect(snap.session?.id).toBe(before.session?.id);
    expect(snap.group.liveVersion).toBe(before.group.liveVersion);

    const again = await importSheet(g, sheetCsv(60));
    expect([again.result.fresh.length, again.result.already.length, again.sent]).toEqual([0, 60, 0]);
    expect(imported(await snapshot(g))).toHaveLength(60);

    const more = await importSheet(g, sheetCsv(65));
    expect([more.result.fresh.length, more.result.already.length]).toEqual([5, 60]);
    expect(imported(await snapshot(g))).toHaveLength(65);

    // 시트에서 7번 경기의 승패를 뒤집었다: 새 경기로 넣지 않고 바뀐 줄로 보여준다.
    const flipped = sheetCsv(65, (no, rows) => {
      if (no === 7) for (const r of rows) r[5] = r[5] === "승" ? "패" : "승";
    });
    const changed = await importSheet(g, flipped);
    expect(changed.result.changed).toHaveLength(1);
    expect(changed.result.changed[0]!.previous.matchNo).toBeGreaterThan(1);
    expect(changed.sent).toBe(0);
    expect(imported(await snapshot(g))).toHaveLength(65);

    snap = await snapshot(g);
    expect(snap.rotation).toEqual(before.rotation);
    expect(snap.group.liveVersion).toBe(before.group.liveVersion);
  });

  it("이미 들어간 지문을 다시 보내면 서버가 거절한다(다른 탭에서 동시에 가져온 경우)", async () => {
    const g = await setupGroup(12);
    const rows = parseDelimited(sheetCsv(3));
    const parsed = parseSheet(rows, { ...detectMapping(rows), year: 2026 }, { today: "2026-11-05" });
    const idOf = new Map(g.people.map((p) => [p.name, p.id]));
    const payload = toSheetPayload(parsed.matches, (n) => idOf.get(n)!, "unknown", "Asia/Seoul");
    const send = () =>
      api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
        requestId: requestId(),
        batchId: unique("batch"),
        source: { kind: "sheet", sourceKey: SOURCE_KEY },
        matches: payload,
      });
    expect((await send()).status).toBe(200);
    const dup = await send();
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("ALREADY_IMPORTED");
    expect(dup.body.error.details.indexes).toEqual([0, 1, 2]);
    expect(imported(await snapshot(g))).toHaveLength(3);
  });

  it("지문·출처 형식이 틀리면 거절한다", async () => {
    const g = await setupGroup(12);
    const base = { requestId: requestId(), batchId: unique("batch") };
    const roster = rosterOf(g.people);
    const match = { playedAt: "2026-10-01T03:00:00.000Z", roster, winnerTeam: "A", winnerSide: "unknown" };
    const bad = [
      { ...base, matches: [{ ...match, fingerprint: "zzz" }] },
      { ...base, matches: [{ ...match, rowKey: "2026-10-01#1" }] },
      { ...base, source: { kind: "sheet", sourceKey: "https://evil" }, matches: [match] },
      { ...base, source: { kind: "web" }, matches: [match] },
    ];
    for (const body of bad) {
      const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(imported(await snapshot(g))).toHaveLength(0);
  });

  it("묶음 단위 전적 제외·복구가 되고, 제외한 묶음의 경기는 다시 가져올 수 있다", async () => {
    const g = await setupGroup(12);
    const { batchId } = await importSheet(g, sheetCsv(4));
    const off = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/${batchId}`, { requestId: requestId(), exclude: true });
    expect(off.body.changed).toBe(4);
    const again = await importSheet(g, sheetCsv(4));
    expect(again.result.fresh).toHaveLength(4);
    expect(again.result.wasExcluded).toBe(4);
    // 다시 넣은 뒤에는 0건.
    expect((await importSheet(g, sheetCsv(4))).sent).toBe(0);
    // 같은 경기가 다시 들어가 있으므로 처음 묶음을 복구하면 같은 경기가 두 번 세진다: 거절하고 겹치는 경기를 알려 준다.
    const before = await snapshot(g);
    const on = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/${batchId}`, { requestId: requestId(), exclude: false });
    expect(on.status).toBe(409);
    expect(on.body.error.code).toBe("RESTORE_DUPLICATE");
    expect(on.body.error.details.overlaps).toHaveLength(4);
    expect(on.body.error.details.restorable).toBe(0);
    expect(on.body.error.details.overlaps[0].with).toHaveLength(1);
    expect((await snapshot(g)).matches.map((m) => [m.id, m.state, m.version])).toEqual(
      before.matches.map((m) => [m.id, m.state, m.version]),
    );
    // 겹치지 않는 경기만 복구를 골라도 남는 경기가 없다.
    const partial = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/${batchId}`, {
      requestId: requestId(),
      exclude: false,
      skipOverlapping: true,
    });
    expect(partial.body).toEqual({ changed: 0, skipped: 4 });
    expect(imported(await snapshot(g)).filter((m) => m.state === "confirmed")).toHaveLength(4);
  });

  it("복구는 겹치는 경기만 빼고 할 수 있고, 한 경기 복구는 겹치는 경기 번호를 알려 주며 거절한다", async () => {
    const g = await setupGroup(12);
    const { batchId } = await importSheet(g, sheetCsv(4));
    await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/${batchId}`, { requestId: requestId(), exclude: true });
    // 시트에 처음 2경기만 남은 상태로 다시 가져온다.
    const again = await importSheet(g, sheetCsv(2));
    expect(again.sent).toBe(2);
    const snap = await snapshot(g);
    const old = imported(snap).filter((m) => m.state === "excluded").sort((x, y) => x.matchNo - y.matchNo);
    const fresh = imported(snap).filter((m) => m.state === "confirmed").sort((x, y) => x.matchNo - y.matchNo);
    expect(old).toHaveLength(4);

    // 한 경기 복구: 겹치는 경기는 거절(경기 번호 안내), 겹치지 않는 경기는 복구된다.
    const dup = await matchAction(g, old[0]!, "restore");
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("RESTORE_DUPLICATE");
    expect(dup.body.error.details.matchNos).toEqual([fresh[0]!.matchNo]);
    expect(dup.body.error.message).toContain(`${fresh[0]!.matchNo}번`);
    const ok = await matchAction(g, old[2]!, "restore");
    expect(ok.status).toBe(200);

    // 묶음 복구: 남은 3경기 중 2경기가 겹친다. 기본은 거절, 고르면 겹치지 않는 1경기만 복구.
    const all = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/${batchId}`, { requestId: requestId(), exclude: false });
    expect(all.status).toBe(409);
    expect(all.body.error.details).toMatchObject({ restorable: 1 });
    expect(all.body.error.details.overlaps.map((o: any) => o.matchNo)).toEqual([old[0]!.matchNo, old[1]!.matchNo]);
    const some = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/${batchId}`, {
      requestId: requestId(),
      exclude: false,
      skipOverlapping: true,
    });
    expect(some.body).toEqual({ changed: 1, skipped: 2 });
    const after = imported(await snapshot(g));
    expect(after.filter((m) => m.state === "confirmed").map((m) => m.matchNo).sort((x, y) => x - y)).toEqual(
      [old[2]!.matchNo, old[3]!.matchNo, fresh[0]!.matchNo, fresh[1]!.matchNo].sort((x, y) => x - y),
    );
    // 새로 넣은 쪽을 제외하면 예전 경기를 복구할 수 있다.
    expect((await matchAction(g, fresh[0]!, "exclude")).status).toBe(200);
    expect((await matchAction(g, old[0]!, "restore")).status).toBe(200);
  });

  it("지문 없는 예전 일괄 입력·지난 경기 입력도 내용으로 견줘 복구를 막는다", async () => {
    const g = await setupGroup(12);
    const roster = rosterOf(g.people);
    // 예전 화면처럼 지문 없이 넣은 경기(한국 시간 정오).
    const legacy = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId: unique("batch"),
      matches: [{ playedAt: "2026-10-01T03:00:00.000Z", roster, winnerTeam: "A", winnerSide: "unknown" }],
    });
    expect(legacy.status).toBe(200);
    const legacyMatch = (await snapshot(g)).matches.find((m) => m.id === legacy.body.matchIds[0])!;
    expect((await matchAction(g, legacyMatch, "exclude")).status).toBe(200);
    // 같은 내용을 지문과 함께 다시 넣는다(제외한 경기와 같은 내용이라 허용).
    const csv = ["날짜,A1,A2,A3,A4,A5,B1,B2,B3,B4,B5,승리", ["2026-10-01", ...g.people.slice(0, 10).map((p) => p.name), "A"].join(",")].join("\r\n");
    expect((await importSheet(g, csv)).sent).toBe(1);
    const restoreLegacy = await matchAction(g, (await snapshot(g)).matches.find((m) => m.id === legacyMatch.id)!, "restore");
    expect(restoreLegacy.status).toBe(409);
    expect(restoreLegacy.body.error.code).toBe("RESTORE_DUPLICATE");
    // 지문 없는 경기가 이미 있으면 같은 내용을 지문과 함께 보내도 서버가 거절한다(화면 비교를 건너뛴 경우).
    const g2 = await setupGroup(12);
    const legacy2 = await api(g2.cookie, "POST", `/api/groups/${g2.gid}/matches/import`, {
      requestId: requestId(),
      batchId: unique("batch"),
      matches: [{ playedAt: "2026-10-01T03:00:00.000Z", roster: rosterOf(g2.people), winnerTeam: "A", winnerSide: "unknown" }],
    });
    expect(legacy2.status).toBe(200);
    const rows = parseDelimited(["날짜,A1,A2,A3,A4,A5,B1,B2,B3,B4,B5,승리", ["2026-10-01", ...g2.people.slice(0, 10).map((p) => p.name), "A"].join(",")].join("\r\n"));
    const parsed = parseSheet(rows, { ...detectMapping(rows), year: 2026 }, { today: "2026-11-05" });
    const idOf = new Map(g2.people.map((p) => [p.name, p.id]));
    const forced = await api(g2.cookie, "POST", `/api/groups/${g2.gid}/matches/import`, {
      requestId: requestId(),
      batchId: unique("batch"),
      source: { kind: "sheet", sourceKey: SOURCE_KEY },
      matches: toSheetPayload(parsed.matches, (n) => idOf.get(n)!, "unknown", "Asia/Seoul"),
    });
    expect(forced.status).toBe(409);
    expect(forced.body.error.code).toBe("ALREADY_IMPORTED");
  });

  it("백업 → 복원(같은 모임·새 모임) 뒤에도 출처와 중복 방지가 유지된다", async () => {
    const g = await setupGroup(12);
    await importSheet(g, sheetCsv(6));
    const backup = (await api(g.cookie, "GET", `/api/groups/${g.gid}/export`)).body;
    expect(backup.formatVersion).toBe(4);
    expect(backup.importBatches).toHaveLength(1);
    expect(backup.importBatches[0]).toMatchObject({ kind: "sheet", sourceKey: SOURCE_KEY, label: "내전 기록 - 2026" });
    expect(backup.matches.filter((m: any) => m.importFingerprint).length).toBe(6);

    // 복원 전에 경기를 더 넣어 둔다(복원하면 사라져야 한다).
    await importSheet(g, sheetCsv(8));
    const snap = await snapshot(g);
    const restored = await api(g.cookie, "POST", `/api/groups/${g.gid}/restore`, {
      requestId: requestId(),
      confirm: "복원",
      baseGeneration: snap.group.generation,
      backup,
    });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect((await fingerprints(g)).length).toBe(6);
    const after = await importSheet(g, sheetCsv(8));
    expect([after.result.already.length, after.result.fresh.length]).toEqual([6, 2]);
    expect((await snapshot(g)).importBatches?.every((b) => b.kind === "sheet")).toBe(true);

    // 새 모임으로 가져와도 지문·출처가 따라간다(묶음 ID는 새로 만든다).
    const cookie = await login();
    const created = await api(cookie, "POST", "/api/restore/new-group", { requestId: requestId(), confirm: "복원", backup });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const ng: TestGroup = { cookie, gid: created.body.groupId, people: [] };
    const ngSnap = await snapshot(ng);
    expect(ngSnap.importBatches?.[0]).toMatchObject({ kind: "sheet", label: "내전 기록 - 2026", count: 6 });
    expect(ngSnap.importBatches?.[0]!.id).not.toBe(backup.importBatches[0].id);
    expect((await fingerprints(ng)).every((f) => f.sourceKey === SOURCE_KEY)).toBe(true);
    const ngAgain = await importSheet(ng, sheetCsv(6));
    expect(ngAgain.sent).toBe(0);
  });

  it("모임을 지우면 출처 기록도 지워진다", async () => {
    const g = await setupGroup(12);
    await importSheet(g, sheetCsv(2));
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/delete`, { confirm: "삭제" });
    expect(res.status).toBe(200);
    const { env } = await import("cloudflare:test");
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM import_batches WHERE group_id = ?1").bind(g.gid).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
});
