import { afterEach, describe, expect, it } from "vitest";
import { sheetHooks } from "../src/server/sheets";
import { direct } from "./direct";
import { setupGroup, type TestGroup } from "./helpers";

// 시트를 탭 이름으로 읽기: 이름 → gid는 공개 보기 페이지(htmlview)의 탭 목록에서 찾고, 내용은 늘 export?gid=로 읽는다.
// 없는 이름은 엉뚱한 탭(첫 탭)을 읽지 않고 탭 목록과 함께 알린다.

const DOC = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
const NO_GID_URL = `https://docs.google.com/spreadsheets/d/${DOC}/edit?usp=sharing`;
const HTMLVIEW = `https://docs.google.com/spreadsheets/d/${DOC}/htmlview`;
const exportOf = (gid: string | null) =>
  `https://docs.google.com/spreadsheets/d/${DOC}/export?format=csv${gid === null ? "" : `&gid=${gid}`}`;

afterEach(() => {
  sheetHooks.fetch = null;
});

const tabsHtml =
  '<html><script>items.push({name: "26\\ub144", pageUrl: "https:\\/\\/docs.google.com\\/x?gid=111", gid: "111",initialSheet: ("111" == gid)});' +
  'items.push({name: "RAW DATA\\uae30\\uc785", pageUrl: "https:\\/\\/docs.google.com\\/x?gid=0", gid: "0",initialSheet: ("0" == gid)});</script></html>';

function fake(routes: Record<string, () => Response>): string[] {
  const calls: string[] = [];
  sheetHooks.fetch = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new Error(`unexpected ${url}`);
    return route();
  };
  return calls;
}
const csv = (body: string) => () => new Response(body, { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8" } });
const html = (body: string, status = 200) => () => new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

async function read(g: TestGroup, body: Record<string, unknown>) {
  const res = await direct({}, "POST", `/api/groups/${g.gid}/sheets/read`, { cookie: g.cookie, body });
  return { status: res.status, body: (await res.json()) as any };
}

describe("시트 탭 고르기", () => {
  it("주소에 탭 번호가 없으면 첫 탭을 읽고 탭 목록을 함께 준다(출처 열쇠는 이전과 같이 first)", async () => {
    const g = await setupGroup(0);
    const calls = fake({ [HTMLVIEW]: html(tabsHtml), [exportOf(null)]: csv("a,b") });
    const res = await read(g, { url: NO_GID_URL });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tabs).toEqual([
      { name: "26년", gid: "111" },
      { name: "RAW DATA기입", gid: "0" },
    ]);
    expect(res.body.tab).toEqual({ name: "26년", gid: "111" });
    expect(res.body.sourceKey).toBe(`sheet:${DOC}:first`);
    expect(calls).toEqual([HTMLVIEW, exportOf(null)]);
  });

  it("탭 목록을 못 얻어도 첫 탭은 그대로 읽는다", async () => {
    const g = await setupGroup(0);
    fake({ [HTMLVIEW]: html("<html>목록 없음</html>"), [exportOf(null)]: csv("a,b") });
    const res = await read(g, { url: NO_GID_URL });
    expect(res.status).toBe(200);
    expect(res.body.tabs).toBeUndefined();
  });

  it("탭 이름으로 gid를 찾아 그 탭을 export로 읽는다", async () => {
    const g = await setupGroup(0);
    const calls = fake({ [HTMLVIEW]: html(tabsHtml), [exportOf("0")]: csv("raw,data") });
    const res = await read(g, { url: NO_GID_URL, tab: " raw data기입 " });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.csv).toBe("raw,data");
    expect(res.body.sourceKey).toBe(`sheet:${DOC}:0`);
    expect(res.body.tab).toEqual({ name: "RAW DATA기입", gid: "0" });
    expect(calls).toEqual([HTMLVIEW, exportOf("0")]);
  });

  it("없는 탭 이름은 첫 탭을 읽지 않고 이 시트의 탭 목록과 함께 알린다", async () => {
    const g = await setupGroup(0);
    const calls = fake({ [HTMLVIEW]: html(tabsHtml) });
    const res = await read(g, { url: NO_GID_URL, tab: "없는 탭" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SHEET_TAB_NOT_FOUND");
    expect(res.body.error.details.tabs).toEqual(["26년", "RAW DATA기입"]);
    expect(calls).toEqual([HTMLVIEW]);
  });

  it("비공개 시트는 탭 이름으로 읽을 때도 비공개로 안내하고, 게시 주소는 탭 이름을 받지 않는다", async () => {
    const g = await setupGroup(0);
    fake({ [HTMLVIEW]: () => new Response(null, { status: 302, headers: { Location: "https://accounts.google.com/ServiceLogin" } }) });
    expect((await read(g, { url: NO_GID_URL, tab: "RAW DATA기입" })).body.error.code).toBe("SHEET_PRIVATE");
    const calls = fake({});
    const pub = await read(g, { url: "https://docs.google.com/spreadsheets/d/e/2PACX-1vTabcdefghijklmnopqrstuvwxyz/pubhtml", tab: "x" });
    expect(pub.body.error.code).toBe("SHEET_PUB_TAB");
    expect(calls).toHaveLength(0);
  });
});
