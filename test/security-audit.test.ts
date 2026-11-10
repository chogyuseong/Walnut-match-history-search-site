import { describe, expect, it } from "vitest";
import type { Env } from "../src/server/env";
import { normalizeMemo } from "../src/shared/memo";
import { cleanName, nameKey } from "../src/shared/names";
import type { Snapshot } from "../src/shared/types";
import { direct } from "./direct";
import { api, login, setupGroup, unique } from "./helpers";
import headersFile from "../public/_headers?raw";

// 2026-11-10 보안 감사 수정(docs/개선-서버-2026-11-10.md): 비밀번호 페퍼 분리, __Host- 세션 쿠키, 대표 운영자 작업의
// 비밀번호 재확인, 로그아웃 때 캐시 비우기, 보이지 않는 문자, 보안 헤더. 요청 수 제한 쪽은 test/ratelimit.test.ts,
// 스냅숏 하루 예산은 test/snapshot-limits.test.ts, 아이디별 하루 실패 한도는 test/local-accounts.test.ts에 있다.

const PASSWORD = "correct horse 1";
const PROD: Partial<Env> = {
  DEPLOY_ENV: "production",
  AUTH_MODE: "oauth",
  PUBLIC_ORIGIN: "https://example.test",
  SESSION_SECRET: "s".repeat(40),
  PASSWORD_PEPPER: "p".repeat(40),
};

let n = 0;
function newName(): string {
  n += 1;
  return `a${Date.now().toString(36)}${n}`.slice(0, 20);
}

async function send(
  overrides: Partial<Env>,
  method: string,
  path: string,
  options: { cookie?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any; response: Response }> {
  const response = await direct(overrides, method, path, {
    ...options,
    headers: { "CF-Connecting-IP": unique("ip"), ...(options.headers ?? {}) },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, response };
}

/** 응답의 세션 쿠키 줄(Set-Cookie 한 줄 전체). 이름은 환경에 따라 sid 또는 __Host-sid다. */
function sessionLine(response: Response): string | undefined {
  return response.headers.getSetCookie().find((l) => /^(__Host-)?sid=/.test(l));
}

/** 자체 계정으로 가입해 "이름=값" 쿠키를 받는다. */
async function signupLocal(overrides: Partial<Env> = {}): Promise<{ cookie: string; username: string }> {
  const username = newName();
  const result = await send(overrides, "POST", "/api/auth/signup", { body: { username, password: PASSWORD } });
  expect(result.status).toBe(200);
  return { cookie: sessionLine(result.response)!.split(";")[0]!, username };
}

describe("비밀번호 페퍼 설정 점검", () => {
  it("운영에서는 PASSWORD_PEPPER가 없거나 32자 미만이거나 SESSION_SECRET과 같으면 모든 API를 거절한다", async () => {
    expect((await send(PROD, "GET", "/api/health")).status).toBe(200);
    for (const pepper of [undefined, "", "short-pepper", PROD.SESSION_SECRET]) {
      const result = await send({ ...PROD, PASSWORD_PEPPER: pepper } as Partial<Env>, "GET", "/api/health");
      expect(result.status, String(pepper)).toBe(503);
      expect(result.body.error.code).toBe("CONFIG_ERROR");
    }
    // 로컬(DEPLOY_ENV=local)은 점검하지 않는다.
    expect((await send({ PASSWORD_PEPPER: undefined } as Partial<Env>, "GET", "/api/health")).status).toBe(200);
  });
});

describe("세션 쿠키 이름", () => {
  it("운영은 __Host-sid(Secure, Path=/, Domain 없음)이고 예전 이름 sid의 쿠키는 받지 않는다. 로컬은 sid다", async () => {
    const username = newName();
    const signed = await send(PROD, "POST", "/api/auth/signup", { body: { username, password: PASSWORD } });
    expect(signed.status).toBe(200);
    const line = sessionLine(signed.response)!;
    expect(line.startsWith("__Host-sid=")).toBe(true);
    for (const part of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) expect(line).toContain(part);
    expect(line).not.toMatch(/Domain=/i);
    const pair = line.split(";")[0]!;
    expect((await send(PROD, "GET", "/api/me", { cookie: pair })).body.accountId).toBeTruthy();
    // 같은 값을 예전 이름으로 보내면 로그인으로 보지 않는다.
    const oldName = pair.replace(/^__Host-sid=/, "sid=");
    expect((await send(PROD, "GET", "/api/me", { cookie: oldName })).body.accountId).toBeNull();
    // 로그아웃은 같은 이름의 쿠키를 지운다.
    const out = await send(PROD, "POST", "/api/auth/logout", { cookie: pair });
    expect(out.response.headers.getSetCookie().some((l) => l.startsWith("__Host-sid=;") && l.includes("Max-Age=0"))).toBe(true);

    const local = await send({}, "POST", "/api/auth/signup", { body: { username: newName(), password: PASSWORD } });
    expect(sessionLine(local.response)!.startsWith("sid=")).toBe(true);
  });
});

describe("대표 운영자의 되돌리기 어려운 작업은 지금 비밀번호를 다시 확인한다", () => {
  async function ownGroup() {
    const { cookie } = await signupLocal();
    const created = await send({}, "POST", "/api/groups", { cookie, body: { requestId: unique("req") } });
    expect(created.status).toBe(200);
    return { cookie, gid: created.body.id as string };
  }

  it("모임 삭제: 비밀번호가 없거나 틀리면 지우지 않는다", async () => {
    const { cookie, gid } = await ownGroup();
    const none = await send({}, "POST", `/api/groups/${gid}/delete`, { cookie, body: { confirm: "삭제" } });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("WRONG_PASSWORD");
    const wrong = await send({}, "POST", `/api/groups/${gid}/delete`, { cookie, body: { confirm: "삭제", password: "nope nope nope" } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("WRONG_PASSWORD");
    expect((await send({}, "GET", `/api/groups/${gid}/snapshot`, { cookie })).status).toBe(200);
    const done = await send({}, "POST", `/api/groups/${gid}/delete`, { cookie, body: { confirm: "삭제", password: PASSWORD } });
    expect(done.status).toBe(200);
    expect((await send({}, "GET", `/api/groups/${gid}/snapshot`, { cookie })).status).toBe(404);
  });

  it("운영자 넘기기: 비밀번호가 맞아야 인수 링크를 만든다", async () => {
    const { cookie, gid } = await ownGroup();
    const none = await send({}, "POST", `/api/groups/${gid}/transfer`, { cookie });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("WRONG_PASSWORD");
    expect((await send({}, "POST", `/api/groups/${gid}/transfer`, { cookie, body: { password: "nope nope nope" } })).status).toBe(400);
    const made = await send({}, "POST", `/api/groups/${gid}/transfer`, { cookie, body: { password: PASSWORD } });
    expect(made.status).toBe(200);
    expect(made.body.token).toBeTruthy();
    // 모르는 항목은 받지 않는다.
    const extra = await send({}, "POST", `/api/groups/${gid}/transfer`, { cookie, body: { password: PASSWORD, to: "x" } });
    expect(extra.status).toBe(400);
  });

  it("같은 모임 복원: 비밀번호가 맞아야 복원한다. 새 모임으로 가져오기는 묻지 않는다", async () => {
    const { cookie, gid } = await ownGroup();
    const backup = (await send({}, "GET", `/api/groups/${gid}/export`, { cookie })).body;
    const generation = ((await send({}, "GET", `/api/groups/${gid}/snapshot`, { cookie })).body as Snapshot).group.generation;
    const body = { requestId: unique("req"), confirm: "복원", baseGeneration: generation, backup };
    const none = await send({}, "POST", `/api/groups/${gid}/restore`, { cookie, body });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe("WRONG_PASSWORD");
    const wrong = await send({}, "POST", `/api/groups/${gid}/restore`, { cookie, body: { ...body, password: "nope nope nope" } });
    expect(wrong.status).toBe(400);
    const done = await send({}, "POST", `/api/groups/${gid}/restore`, { cookie, body: { ...body, password: PASSWORD } });
    expect(done.status).toBe(200);
    const fresh = await send({}, "POST", "/api/restore/new-group", {
      cookie,
      body: { requestId: unique("req"), confirm: "복원", backup },
    });
    expect(fresh.status).toBe(200);
  });

  it("비밀번호가 없는 계정(개발용·카카오·Google)은 비밀번호 없이 그대로 된다", async () => {
    const g = await setupGroup(0);
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/transfer`)).status).toBe(200);
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/delete`, { confirm: "삭제" })).status).toBe(200);
  });
});

describe("로그아웃·탈퇴는 브라우저 캐시를 비우게 한다", () => {
  it("Clear-Site-Data: \"cache\"", async () => {
    const cookie = await login();
    const out = await send({}, "POST", "/api/auth/logout", { cookie });
    expect(out.status).toBe(200);
    expect(out.response.headers.get("Clear-Site-Data")).toBe('"cache"');
    const gone = await send({}, "POST", "/api/account/delete", { cookie: await login(), body: { confirm: "탈퇴" } });
    expect(gone.status).toBe(200);
    expect(gone.response.headers.get("Clear-Site-Data")).toBe('"cache"');
    // 다른 응답에는 붙이지 않는다.
    expect((await send({}, "GET", "/api/me", { cookie: await login() })).response.headers.get("Clear-Site-Data")).toBeNull();
  });
});

describe("보이지 않는 문자(방향 제어·폭 없는 문자)", () => {
  const cp = (...codes: number[]) => String.fromCharCode(...codes);
  const RLO = cp(0x202e);
  const ZWSP = cp(0x200b);
  const ZWJ = cp(0x200d);
  const WJ = cp(0x2060);
  const BOM = cp(0xfeff);
  const LRI = cp(0x2066);
  const PDI = cp(0x2069);

  it("이름에서 지운다: 똑같아 보이는 다른 이름을 만들 수 없다", () => {
    expect(cleanName(`도${ZWSP}토${ZWJ}리`)).toBe("도토리");
    expect(cleanName(`${RLO}도토리${WJ}`)).toBe("도토리");
    expect(cleanName(`${LRI}밤${PDI}송이${BOM}`)).toBe("밤송이");
    expect(nameKey(`A${ZWSP}b`)).toBe(nameKey("ab"));
    // 보이는 글자와 보통 공백은 그대로다.
    expect(cleanName("  밤  송이 ")).toBe("밤 송이");
    expect(cleanName(`${ZWSP}${RLO}`)).toBe("");
  });

  it("메모에서 지운다(줄바꿈은 남긴다)", () => {
    expect(normalizeMemo(`첫 줄${RLO}\n둘째${ZWSP} 줄`)).toBe("첫 줄\n둘째 줄");
    expect(normalizeMemo(`${ZWSP}${BOM}`)).toBeNull();
  });

  it("서버: 보이지 않는 문자만 다른 이름은 같은 참가자다. 그것만으로 된 이름은 거절한다", async () => {
    const g = await setupGroup(0);
    const first = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: [`호${ZWSP}두`] });
    expect(first.status).toBe(200);
    expect(first.body.participants[0].name).toBe("호두");
    const again = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: [`${RLO}호두`] });
    expect(again.body.participants[0].id).toBe(first.body.participants[0].id);
    expect((await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, { names: [ZWSP] })).status).toBe(400);
  });
});

describe("보안 헤더·출처 확인 보강", () => {
  it("API 응답과 정적 화면 헤더에 COOP·CORP same-origin이 있다", async () => {
    for (const path of ["/api/health", "/api/nope"]) {
      const { response } = await send({}, "GET", path);
      expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    }
    expect(headersFile).toContain("Cross-Origin-Opener-Policy: same-origin");
    expect(headersFile).toContain("Cross-Origin-Resource-Policy: same-origin");
  });

  it("쓰기 요청의 Sec-Fetch-Site가 cross-site면 거절한다. 없거나 same-origin·same-site·none이면 Origin 확인으로 넘어간다", async () => {
    const g = await setupGroup(0);
    const rename = (headers: Record<string, string>) =>
      send({}, "PATCH", `/api/groups/${g.gid}`, { cookie: g.cookie, body: { name: "새 이름", requestId: unique("req") }, headers });
    const cross = await rename({ "Sec-Fetch-Site": "cross-site" });
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe("BAD_ORIGIN");
    // Origin을 같게 꾸며도(브라우저 밖에서는 가능) Sec-Fetch-Site가 cross-site면 거절한다.
    expect((await rename({ "Sec-Fetch-Site": "cross-site", Origin: "https://example.test" })).status).toBe(403);
    for (const site of ["same-origin", "same-site", "none"]) {
      expect((await rename({ "Sec-Fetch-Site": site })).status, site).toBe(200);
    }
    expect((await rename({})).status).toBe(200);
    // same-site여도 Origin이 다르면 Origin 확인이 거절한다(같은 계정의 다른 workers.dev Worker).
    expect((await rename({ "Sec-Fetch-Site": "same-site", Origin: "https://other.example.test" })).status).toBe(403);
    // 읽기는 보지 않는다.
    const read = await send({}, "GET", `/api/groups/${g.gid}/snapshot`, { cookie: g.cookie, headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(read.status).toBe(200);
  });
});
