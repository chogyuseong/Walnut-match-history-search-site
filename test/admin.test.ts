import { describe, expect, it } from "vitest";
import { parseMatchTable, toImportMatches } from "../src/shared/importTable";
import { nameKey } from "../src/shared/names";
import { personRecords } from "../src/shared/stats";
import {
  api,
  fingerprint,
  login,
  matchAction,
  playConfirmed,
  requestId,
  rosterOf,
  setupGroup,
  snapshot,
  type TestGroup,
} from "./helpers";

const names = (from: number) => Array.from({ length: 5 }, (_, i) => `참가자${from + i}`).join("\t");
const row = (date: string, winner: string) => `${date}\t${names(1)}\t${names(6)}\t${winner}`;

async function importRows(g: TestGroup, batchId: string, lines: string[]) {
  const parsed = parseMatchTable(lines.join("\n"));
  const idOf = new Map(g.people.map((p) => [nameKey(p.name), p.id]));
  return api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
    requestId: requestId(),
    batchId,
    matches: toImportMatches(parsed.rows, (name) => idOf.get(nameKey(name))!, "unknown"),
  });
}

describe("일괄 입력 한 번에 되돌리기", () => {
  it("묶음의 경기만 전적 제외하고 다시 복구할 수 있다", async () => {
    const g = await setupGroup();
    const live = await playConfirmed(g, rosterOf(g.people));
    await importRows(g, "batch-aaaa-0001", [row("2026-09-01", "A"), row("2026-09-02", "A")]);
    await importRows(g, "batch-bbbb-0002", [row("2026-09-03", "B")]);

    const before = await snapshot(g);
    expect(before.importBatches?.map((b) => [b.id, b.count, b.excluded]).sort()).toEqual([
      ["batch-aaaa-0001", 2, 0],
      ["batch-bbbb-0002", 1, 0],
    ]);
    expect(personRecords(before.matches).get(g.people[0]!.id)?.games).toBe(4);

    const excluded = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/batch-aaaa-0001`, {
      requestId: requestId(),
      exclude: true,
    });
    expect(excluded.status).toBe(200);
    expect(excluded.body.changed).toBe(2);
    const after = await snapshot(g);
    // 직접 한 경기와 다른 묶음은 그대로다.
    expect(after.matches.find((m) => m.id === live.id)!.state).toBe("confirmed");
    expect(after.matches.filter((m) => m.state === "excluded")).toHaveLength(2);
    expect(personRecords(after.matches).get(g.people[0]!.id)?.games).toBe(2);
    expect(after.importBatches?.find((b) => b.id === "batch-aaaa-0001")).toMatchObject({
      count: 2,
      excluded: 2,
    });
    // 경기마다 변경 이력이 남는다.
    expect(after.revisions.filter((r) => r.kind === "exclude")).toHaveLength(2);

    const restored = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/batch-aaaa-0001`, {
      requestId: requestId(),
      exclude: false,
    });
    expect(restored.body.changed).toBe(2);
    const final = await snapshot(g);
    expect(final.matches.filter((m) => m.state === "excluded")).toHaveLength(0);
    expect(personRecords(final.matches).get(g.people[0]!.id)?.games).toBe(4);
  });

  it("묶음 제외 뒤에도 경기 하나만 따로 복구할 수 있다", async () => {
    const g = await setupGroup();
    await importRows(g, "batch-cccc-0003", [row("2026-09-01", "A"), row("2026-09-02", "B")]);
    await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/batch-cccc-0003`, {
      requestId: requestId(),
      exclude: true,
    });
    const one = (await snapshot(g)).matches[0]!;
    const restored = await matchAction(g, one, "restore");
    expect(restored.status).toBe(200);
    expect(restored.body.match.state).toBe("confirmed");
  });

  it("없는 묶음과 다른 모임의 묶음은 찾지 못한다", async () => {
    const g = await setupGroup();
    const other = await setupGroup();
    await importRows(g, "batch-dddd-0004", [row("2026-09-01", "A")]);
    const missing = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/batch-none-9999`, {
      requestId: requestId(),
      exclude: true,
    });
    expect(missing.status).toBe(404);
    // 다른 모임 운영자가 자기 모임 주소로 이 묶음 ID를 써도 찾지 못한다.
    const foreign = await api(
      other.cookie,
      "POST",
      `/api/groups/${other.gid}/imports/batch-dddd-0004`,
      { requestId: requestId(), exclude: true },
    );
    expect(foreign.status).toBe(404);
    expect((await snapshot(g)).matches[0]!.state).toBe("confirmed");
  });

  it("조회 응답에는 일괄 입력 기록이 없다", async () => {
    const g = await setupGroup();
    await importRows(g, "batch-eeee-0005", [row("2026-09-01", "A")]);
    const token = (await snapshot(g)).group.viewToken!;
    const view = await api(null, "GET", `/api/view/${token}`);
    expect(view.body.importBatches).toBeUndefined();
    expect(JSON.stringify(view.body)).not.toContain("batch-eeee-0005");
  });
});

describe("운영자 교체", () => {
  it("인수 링크를 수락하면 권한이 옮겨 가고 기록은 그대로다", async () => {
    const g = await setupGroup();
    await playConfirmed(g, rosterOf(g.people));
    const before = await snapshot(g);
    const created = await api(g.cookie, "POST", `/api/groups/${g.gid}/transfer`);
    expect(created.status).toBe(200);
    const token = created.body.token as string;

    const next = await login();
    const info = await api(next, "GET", `/api/transfer/${token}`);
    expect(info.body.groupName).toBe(before.group.name);

    const accepted = await api(next, "POST", `/api/transfer/${token}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.groupId).toBe(g.gid);

    // 새 운영자는 수정할 수 있고 이전 운영자는 모임 자체가 보이지 않는다.
    const asNew = await api(next, "GET", `/api/groups/${g.gid}/snapshot`);
    expect(asNew.status).toBe(200);
    expect(asNew.body.matches).toEqual(before.matches);
    expect(asNew.body.group.viewToken).toBe(before.group.viewToken);
    expect((await api(g.cookie, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(404);
    const oldWrite = await api(g.cookie, "POST", `/api/groups/${g.gid}/view-token`);
    expect(oldWrite.status).toBe(404);
    expect((await api(g.cookie, "GET", "/api/me")).body.groups).toEqual([]);
    expect((await api(next, "GET", "/api/me")).body.groups).toHaveLength(1);
  });

  it("인수 링크는 한 번만 쓸 수 있다", async () => {
    const g = await setupGroup();
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/transfer`)).body.token as string;
    const first = await login();
    const second = await login();
    expect((await api(first, "POST", `/api/transfer/${token}/accept`)).status).toBe(200);
    const again = await api(second, "POST", `/api/transfer/${token}/accept`);
    expect(again.status).toBe(404);
    expect(again.body.error.code).toBe("TRANSFER_INVALID");
    expect((await api(second, "GET", `/api/groups/${g.gid}/snapshot`)).status).toBe(404);
  });

  it("새 링크를 만들면 이전 링크는 무효가 된다", async () => {
    const g = await setupGroup();
    const oldToken = (await api(g.cookie, "POST", `/api/groups/${g.gid}/transfer`)).body.token;
    const newToken = (await api(g.cookie, "POST", `/api/groups/${g.gid}/transfer`)).body.token;
    const next = await login();
    expect((await api(next, "POST", `/api/transfer/${oldToken}/accept`)).status).toBe(404);
    expect((await api(next, "POST", `/api/transfer/${newToken}/accept`)).status).toBe(200);
  });

  it("로그인하지 않았거나 현재 운영자 본인이면 수락할 수 없다", async () => {
    const g = await setupGroup();
    const token = (await api(g.cookie, "POST", `/api/groups/${g.gid}/transfer`)).body.token as string;
    const before = fingerprint(await snapshot(g));
    expect((await api(null, "POST", `/api/transfer/${token}/accept`)).status).toBe(401);
    const self = await api(g.cookie, "POST", `/api/transfer/${token}/accept`);
    expect(self.status).toBe(409);
    expect(self.body.error.code).toBe("ALREADY_OPERATOR");
    expect(fingerprint(await snapshot(g))).toBe(before);
  });

  it("없는 링크는 모임 정보를 드러내지 않는다", async () => {
    const someone = await login();
    const info = await api(someone, "GET", "/api/transfer/없는토큰");
    expect(info.status).toBe(404);
    expect(JSON.stringify(info.body)).not.toContain("groupName");
  });

  it("운영자가 아니면 인수 링크를 만들 수 없다", async () => {
    const g = await setupGroup();
    const other = await login();
    expect((await api(other, "POST", `/api/groups/${g.gid}/transfer`)).status).toBe(404);
  });
});
