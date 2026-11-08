import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { ipSubject, rateClock } from "../src/server/ratelimit";
import { direct } from "./direct";
import { api, login, requestId, rosterOf, setupGroup, unique, type TestGroup } from "./helpers";

// 보안 점검 후속(2026-11-08, docs/개선-서버-2026-11-08.md "보안 점검 후속" 절).

const realNow = rateClock.now;
afterEach(() => {
  rateClock.now = realNow;
});

/** 창 경계 직후로 시계를 고정한다(준비 단계의 요청과 섞이지 않게 먼 뒤의 창을 쓴다). */
function fixClock(windowMs: number, ahead: number): { advance: (ms: number) => void } {
  let now = Math.floor(Date.now() / windowMs) * windowMs + ahead * windowMs + 1000;
  rateClock.now = () => now;
  return { advance: (ms) => (now += ms) };
}

describe("HEAD 요청도 GET과 같은 요청 수 제한을 거친다", () => {
  it("인수·연결 링크 경로(view-ip)", async () => {
    fixClock(60_000, 40);
    const LIMITS: Partial<Env> = { RATE_VIEW_PER_IP: "2" };
    const ip = unique("ip");
    const head = () => direct(LIMITS, "HEAD", `/api/claim/${unique("nope")}`, { headers: { "CF-Connecting-IP": ip } });
    expect((await head()).status).toBe(404);
    expect((await head()).status).toBe(404);
    expect((await head()).status).toBe(429);
    // GET과 같은 버킷이다.
    const get = await direct(LIMITS, "GET", `/api/claim/${unique("nope")}`, { headers: { "CF-Connecting-IP": ip } });
    expect(get.status).toBe(429);
  });

  it("비싼 읽기(heavy-ip)", async () => {
    const g = await setupGroup(2);
    fixClock(60_000, 41);
    const LIMITS: Partial<Env> = { RATE_HEAVY_PER_IP: "2", RATE_HEAVY_PER_ACCOUNT: "100" };
    const ip = unique("ip");
    const head = () =>
      direct(LIMITS, "HEAD", `/api/groups/${g.gid}/export`, { cookie: g.cookie, headers: { "CF-Connecting-IP": ip } });
    expect((await head()).status).toBe(200);
    expect((await head()).status).toBe(200);
    expect((await head()).status).toBe(429);
  });
});

describe("IPv6는 /64 단위로 센다", () => {
  it("표기가 달라도 같은 /64는 같은 값, 다른 /64는 다른 값, IPv4는 그대로", () => {
    const a = ipSubject("2001:db8:0:1::1");
    expect(a).toBe("2001:db8:0:1::/64");
    expect(ipSubject("2001:0DB8:0000:0001:ffff:0:0:2")).toBe(a);
    expect(ipSubject("[2001:db8:0:1:abcd::9]")).toBe(a);
    expect(ipSubject("2001:db8:0:1::5%eth0")).toBe(a);
    expect(ipSubject("2001:db8:0:1:1:2:1.2.3.4")).toBe(a);
    expect(ipSubject("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipSubject("2001:db8:0:2::1")).not.toBe(a);
    expect(ipSubject("::1")).toBe("0:0:0:0::/64");
    expect(ipSubject("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(ipSubject("203.0.113.7")).toBe("203.0.113.7");
    expect(ipSubject("local")).toBe("local");
    // 형식이 틀리면 그대로(소문자) 쓴다.
    expect(ipSubject("1:2:3")).toBe("1:2:3");
    expect(ipSubject("1::2::3")).toBe("1::2::3");
  });

  it("같은 /64의 다른 주소는 한 버킷, 다른 /64는 따로", async () => {
    fixClock(60_000, 42);
    const LIMITS: Partial<Env> = { RATE_VIEW_PER_IP: "2" };
    const x = Math.floor(Math.random() * 0xffff).toString(16);
    const prefix = `2001:db8:${x}:1`;
    const view = (ip: string) => direct(LIMITS, "GET", `/api/claim/${unique("nope")}`, { headers: { "CF-Connecting-IP": ip } });
    expect((await view(`${prefix}::1`)).status).toBe(404);
    expect((await view(`${prefix}:0:0:0:2`)).status).toBe(404);
    expect((await view(`${prefix}:dead:beef:1:3`)).status).toBe(429);
    expect((await view(`2001:db8:${x}:2::1`)).status).toBe(404);
    // IPv4는 주소마다 따로다.
    expect((await view(unique("198.51.100"))).status).toBe(404);
  });
});

describe("권한을 잃은 운영자가 미리 만든 참가자 연결 링크는 지워진다", () => {
  async function addCoOperator(g: TestGroup): Promise<{ cookie: string; accountId: string }> {
    const invite = await api(g.cookie, "POST", `/api/groups/${g.gid}/co-operators/invite`);
    const cookie = await login();
    expect((await api(cookie, "POST", `/api/co-invite/${invite.body.token}/accept`)).status).toBe(200);
    const accountId = (await api(cookie, "GET", "/api/me")).body.accountId as string;
    return { cookie, accountId };
  }
  async function claimLink(cookie: string, g: TestGroup, index: number): Promise<string> {
    const res = await api(cookie, "POST", `/api/groups/${g.gid}/participants/${g.people[index]!.id}/claim-link`);
    expect(res.status).toBe(200);
    return res.body.token as string;
  }
  async function unusedClaims(gid: string): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM participant_claims WHERE group_id = ?1 AND used_at IS NULL")
      .bind(gid)
      .first<{ n: number }>();
    return row!.n;
  }

  it("대표가 공동 운영자를 내보내면 그 사람이 만든 링크를 쓸 수 없다", async () => {
    const g = await setupGroup(3);
    const co = await addCoOperator(g);
    const token = await claimLink(co.cookie, g, 0);
    expect((await api(null, "GET", `/api/claim/${token}`)).status).toBe(200);
    expect((await api(g.cookie, "DELETE", `/api/groups/${g.gid}/co-operators/${co.accountId}`)).status).toBe(200);
    expect(await unusedClaims(g.gid)).toBe(0);
    expect((await api(null, "GET", `/api/claim/${token}`)).status).toBe(404);
    expect((await api(await login(), "POST", `/api/claim/${token}/accept`)).status).toBe(404);
    // 없는 공동 운영자를 내보내면 404이고 링크는 건드리지 않는다.
    const fresh = await claimLink(g.cookie, g, 1);
    expect((await api(g.cookie, "DELETE", `/api/groups/${g.gid}/co-operators/${co.accountId}`)).status).toBe(404);
    expect((await api(null, "GET", `/api/claim/${fresh}`)).status).toBe(200);
  });

  it("공동 운영자가 스스로 나가도 지운다", async () => {
    const g = await setupGroup(3);
    const co = await addCoOperator(g);
    const token = await claimLink(co.cookie, g, 0);
    expect((await api(co.cookie, "POST", `/api/groups/${g.gid}/co-operators/leave`)).status).toBe(200);
    expect((await api(null, "GET", `/api/claim/${token}`)).status).toBe(404);
  });

  it("대표를 넘기면 이전 대표가 만든 링크를 쓸 수 없다. 이미 쓴 연결은 그대로다", async () => {
    const g = await setupGroup(3);
    const used = await claimLink(g.cookie, g, 0);
    const member = await login();
    expect((await api(member, "POST", `/api/claim/${used}/accept`)).status).toBe(200);
    const pending = await claimLink(g.cookie, g, 1);
    const transfer = await api(g.cookie, "POST", `/api/groups/${g.gid}/transfer`);
    const next = await login();
    expect((await api(next, "POST", `/api/transfer/${transfer.body.token}/accept`)).status).toBe(200);
    expect(await unusedClaims(g.gid)).toBe(0);
    expect((await api(null, "GET", `/api/claim/${pending}`)).status).toBe(404);
    expect((await api(member, "GET", `/api/member/${g.gid}/snapshot`)).status).toBe(200);
  });
});

describe("대량 쓰기 하루 예산(가져오기·지난 경기 입력·복원)", () => {
  const DAY = 86_400_000;

  function importBody(g: TestGroup, count: number, day = 1) {
    return {
      requestId: requestId(),
      batchId: unique("batch"),
      matches: Array.from({ length: count }, (_, i) => ({
        playedAt: new Date(Date.UTC(2026, 0, day, 12, 0, i % 60)).toISOString(),
        roster: rosterOf(g.people),
        winnerTeam: i % 2 === 0 ? "A" : "B",
        winnerSide: "unknown",
      })),
    };
  }

  it("계정 한도를 넘는 묶음은 429이고 아무것도 넣지 않으며 예산도 깎지 않는다. 다음 날 다시 된다", async () => {
    const g = await setupGroup(10);
    const clock = fixClock(DAY, 3);
    const LIMITS: Partial<Env> = { RATE_BULK_ROWS_PER_ACCOUNT: "5", RATE_BULK_ROWS_PER_IP: "100" };
    const ip = unique("ip");
    const send = (path: string, body: unknown) =>
      direct(LIMITS, "POST", `/api/groups/${g.gid}${path}`, { cookie: g.cookie, body, headers: { "CF-Connecting-IP": ip } });
    expect((await send("/matches/import", importBody(g, 3))).status).toBe(200);
    const over = await send("/matches/import", importBody(g, 3));
    expect(over.status).toBe(429);
    const error = ((await over.json()) as { error: { code: string; message: string; retryAfter?: number } }).error;
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toContain("오늘 넣을 수 있는 경기 수를 넘었어요");
    expect(Number(over.headers.get("Retry-After"))).toBeGreaterThan(3600);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM matches WHERE group_id = ?1").bind(g.gid).first<{ n: number }>();
    expect(count!.n).toBe(3);
    // 거절된 묶음은 세지 않았으므로 2경기는 들어간다(3 + 2 = 5).
    expect((await send("/matches/import", importBody(g, 2))).status).toBe(200);
    // 지난 경기 한 건 입력도 같은 예산을 쓴다.
    const backfill = {
      requestId: requestId(),
      playedAt: "2026-01-05T12:00:00.000Z",
      roster: rosterOf(g.people),
      winnerTeam: "A",
      winnerSide: "unknown",
    };
    expect((await send("/matches/backfill", backfill)).status).toBe(429);
    // 같은 요청 ID의 재시도는 예산을 다시 쓰지 않는다(재생).
    clock.advance(DAY);
    expect((await send("/matches/backfill", backfill)).status).toBe(200);
    expect((await send("/matches/backfill", backfill)).status).toBe(200);
    expect((await send("/matches/import", importBody(g, 4))).status).toBe(200);
    expect((await send("/matches/import", importBody(g, 1))).status).toBe(429);
    // 다른 계정은 영향이 없다(IP 한도 안).
    const other = await setupGroup(10);
    const otherSend = await direct(LIMITS, "POST", `/api/groups/${other.gid}/matches/import`, {
      cookie: other.cookie,
      body: importBody(other, 5),
      headers: { "CF-Connecting-IP": ip },
    });
    expect(otherSend.status).toBe(200);
  });

  it("IP 한도는 계정이 달라도 합쳐 센다", async () => {
    const a = await setupGroup(10);
    const b = await setupGroup(10);
    fixClock(DAY, 4);
    const LIMITS: Partial<Env> = { RATE_BULK_ROWS_PER_ACCOUNT: "100", RATE_BULK_ROWS_PER_IP: "6" };
    const ip = unique("ip");
    const send = (g: TestGroup, count: number) =>
      direct(LIMITS, "POST", `/api/groups/${g.gid}/matches/import`, {
        cookie: g.cookie,
        body: importBody(g, count),
        headers: { "CF-Connecting-IP": ip },
      });
    expect((await send(a, 4)).status).toBe(200);
    expect((await send(b, 3)).status).toBe(429);
    expect((await send(b, 2)).status).toBe(200);
  });

  it("정상 사용: 기본 한도(계정 3,000·IP 6,000)에서 522경기를 50경기씩 11번 넣어도 걸리지 않는다", async () => {
    const g = await setupGroup(10);
    fixClock(DAY, 5);
    // 테스트 설정(wrangler.jsonc 로컬)의 넉넉한 값을 지워 코드의 기본 한도를 쓴다.
    const DEFAULTS = { RATE_BULK_ROWS_PER_ACCOUNT: undefined, RATE_BULK_ROWS_PER_IP: undefined } as Partial<Env>;
    const ip = unique("ip");
    let left = 522;
    let day = 1;
    while (left > 0) {
      const count = Math.min(50, left);
      const res = await direct(DEFAULTS, "POST", `/api/groups/${g.gid}/matches/import`, {
        cookie: g.cookie,
        body: importBody(g, count, day++),
        headers: { "CF-Connecting-IP": ip },
      });
      expect(res.status).toBe(200);
      left -= count;
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM matches WHERE group_id = ?1").bind(g.gid).first<{ n: number }>();
    expect(count!.n).toBe(522);
  });

  it("백업 복원(새 모임으로 가져오기·같은 모임 복구)도 파일의 경기 수만큼 쓴다", async () => {
    const g = await setupGroup(10);
    const seeded = await direct({}, "POST", `/api/groups/${g.gid}/matches/import`, {
      cookie: g.cookie,
      body: importBody(g, 3),
      headers: { "CF-Connecting-IP": unique("ip") },
    });
    expect(seeded.status).toBe(200);
    const backup = await (await direct({}, "GET", `/api/groups/${g.gid}/export`, { cookie: g.cookie })).json();
    fixClock(DAY, 6);
    const LIMITS: Partial<Env> = { RATE_BULK_ROWS_PER_ACCOUNT: "5", RATE_BULK_ROWS_PER_IP: "100" };
    const ip = unique("ip");
    const newcomer = await login();
    const importNew = () =>
      direct(LIMITS, "POST", "/api/restore/new-group", {
        cookie: newcomer,
        body: { requestId: requestId(), confirm: "복원", backup },
        headers: { "CF-Connecting-IP": ip },
      });
    expect((await importNew()).status).toBe(200);
    const refused = await importNew();
    expect(refused.status).toBe(429);
    // 거절된 가져오기는 모임을 만들지 않는다(대표 1개만).
    const owned = await env.DB.prepare("SELECT COUNT(*) AS n FROM group_operators WHERE account_id = ?1")
      .bind((await api(newcomer, "GET", "/api/me")).body.accountId)
      .first<{ n: number }>();
    expect(owned!.n).toBe(1);

    // 같은 모임 복구: 원래 운영자(아직 예산을 쓰지 않음)는 한 번 되고, 두 번째는 넘는다.
    const generation = async () =>
      (await env.DB.prepare("SELECT generation FROM groups WHERE id = ?1").bind(g.gid).first<{ generation: number }>())!.generation;
    const restore = async () =>
      direct(LIMITS, "POST", `/api/groups/${g.gid}/restore`, {
        cookie: g.cookie,
        body: { requestId: requestId(), confirm: "복원", baseGeneration: await generation(), backup },
        headers: { "CF-Connecting-IP": unique("ip") },
      });
    expect((await restore()).status).toBe(200);
    expect((await restore()).status).toBe(429);
  });
});
