import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseMatchTable, toImportMatches } from "../src/shared/importTable";
import { nameKey } from "../src/shared/names";
import type { MatchView, RosterEntry } from "../src/shared/types";
import { api, matchAction, requestId, rosterOf, setupGroup, snapshot, start, unique, type TestGroup } from "./helpers";

/*
 * 2026-11-14 점검의 낮음 항목 중 서버 쪽 셋.
 * - 결과 미입력 상한(MAX_AWAITING 10)을 "결과는 나중에"·전적 복구도 지킨다(되살리기는 이미 지켰다).
 * - 일괄 입력 묶음 복구도 한 경기 복구처럼 시리즈 승부 검사를 거친다.
 * - 참가자 등록 뒤 다시 읽기 전에 이름이 바뀌면 500이 아니라 409.
 */

const MAX_AWAITING = 10;
const awaitingCount = async (g: TestGroup) =>
  (await snapshot(g)).matches.filter((m) => m.state === "awaiting_result").length;

/** 같은 명단을 되풀이해 쓰려고 서포터 반복을 허용해 시작한다. */
async function startLive(g: TestGroup, roster: RosterEntry[], extra: Record<string, unknown> = {}): Promise<MatchView> {
  const res = await start(g, roster, { ackRepeat: roster.map((r) => r.participantId), ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.match;
}

async function fillAwaiting(g: TestGroup, roster: RosterEntry[], n: number): Promise<MatchView[]> {
  const out: MatchView[] = [];
  for (let i = 0; i < n; i++) {
    const live = await startLive(g, roster);
    out.push((await matchAction(g, live, "end-later")).body.match);
  }
  return out;
}

describe("결과 미입력 상한", () => {
  it("이미 10개면 진행 중 경기의 '결과는 나중에'를 거절하고, 경기는 진행 중 그대로다", async () => {
    const g = await setupGroup(12);
    const roster = rosterOf(g.people);
    const awaiting = await fillAwaiting(g, roster, MAX_AWAITING);
    const live = await startLive(g, roster);

    const blocked = await matchAction(g, live, "end-later");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("TOO_MANY_AWAITING");
    expect(await awaitingCount(g)).toBe(MAX_AWAITING);
    expect((await snapshot(g)).matches.find((m) => m.id === live.id)!.state).toBe("in_progress");

    // 하나를 확정하면 다시 된다.
    expect((await matchAction(g, awaiting[0]!, "result", { winnerTeam: "A", winnerSide: "blue" })).status).toBe(200);
    expect((await matchAction(g, live, "end-later")).status).toBe(200);
    expect(await awaitingCount(g)).toBe(MAX_AWAITING);
  });

  it("결과 미입력이던 경기를 전적 제외한 사이 10개가 차면 복구를 거절한다", async () => {
    const g = await setupGroup(12);
    const roster = rosterOf(g.people);
    const [old] = await fillAwaiting(g, roster, 1);
    const excluded = (await matchAction(g, old!, "exclude")).body.match as MatchView;
    expect(excluded.state).toBe("excluded");
    await fillAwaiting(g, roster, MAX_AWAITING);

    const blocked = await matchAction(g, excluded, "restore");
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("TOO_MANY_AWAITING");
    expect((await snapshot(g)).matches.find((m) => m.id === old!.id)!.state).toBe("excluded");
    expect(await awaitingCount(g)).toBe(MAX_AWAITING);
  });
});

describe("일괄 입력 묶음 복구와 시리즈", () => {
  const HEADER = "날짜\tA탑\tA정글\tA미드\tA원딜\tA서폿\tB탑\tB정글\tB미드\tB원딜\tB서폿\t승리팀";
  const names = (from: number) => Array.from({ length: 5 }, (_, i) => `참가자${from + i}`);

  async function importOne(g: TestGroup): Promise<{ batchId: string; matchId: string }> {
    const parsed = parseMatchTable([HEADER, ["2026-10-01", ...names(1), ...names(6), "A"].join("\t")].join("\n"), {
      now: Date.now(),
      timeZone: "Asia/Seoul",
    });
    expect(parsed.errors).toEqual([]);
    const ids = new Map(g.people.map((p) => [nameKey(p.name), p.id]));
    const batchId = unique("batch");
    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/import`, {
      requestId: requestId(),
      batchId,
      source: { kind: "paste" },
      matches: toImportMatches(parsed.rows, (n) => ids.get(nameKey(n))!, "unknown", "Asia/Seoul"),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const matchId = (await snapshot(g)).matches.find((m) => m.source === "import")!.id;
    return { batchId, matchId };
  }

  async function playLive(g: TestGroup, winnerTeam: "A" | "B"): Promise<MatchView> {
    const live = await startLive(g, rosterOf(g.people));
    const done = await matchAction(g, live, "result", { winnerTeam, winnerSide: "blue" });
    expect(done.status).toBe(200);
    return done.body.match;
  }

  it("묶음을 제외한 사이 판을 더 넣어 승부가 났으면 묶음 복구를 거절한다(한 경기 복구와 같은 기준)", async () => {
    // 1판(가져온 경기) A 승, 2판 B 승으로 3판 2선승 시리즈. 묶음을 제외하면 B 1승뿐이라 A 승 두 판을 더 넣을 수 있다.
    // 그 뒤 1판을 되돌리면 3판째에 A가 2승으로 끝나고 4판이 남는다.
    const g = await setupGroup(12);
    const imported = await importOne(g);
    const second = await playLive(g, "B");
    const created = await api(g.cookie, "POST", `/api/groups/${g.gid}/series`, {
      requestId: requestId(),
      format: "bo3",
      matchIds: [imported.matchId, second.id],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const seriesId = created.body.series.id as string;

    const exclude = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/${imported.batchId}`, {
      requestId: requestId(),
      exclude: true,
    });
    expect(exclude.status).toBe(200);
    for (const winner of ["A", "A"] as const) {
      const m = await playLive(g, winner);
      const added = await api(g.cookie, "POST", `/api/groups/${g.gid}/series/${seriesId}/add`, {
        requestId: requestId(),
        matchId: m.id,
      });
      expect(added.status, JSON.stringify(added.body)).toBe(200);
    }

    const blocked = await api(g.cookie, "POST", `/api/groups/${g.gid}/imports/${imported.batchId}`, {
      requestId: requestId(),
      exclude: false,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("SERIES_FULL");
    expect(blocked.body.error.message).toContain("이 묶음을 복구하면");
    expect((await snapshot(g)).matches.find((m) => m.id === imported.matchId)!.state).toBe("excluded");
  });

  it("시리즈에 없는 묶음은 예전처럼 복구한다", async () => {
    const g = await setupGroup(12);
    const imported = await importOne(g);
    const path = `/api/groups/${g.gid}/imports/${imported.batchId}`;
    expect((await api(g.cookie, "POST", path, { requestId: requestId(), exclude: true })).status).toBe(200);
    const restored = await api(g.cookie, "POST", path, { requestId: requestId(), exclude: false });
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.changed).toBe(1);
  });
});

describe("참가자 등록 뒤 다시 읽기", () => {
  it("넣은 뒤 다시 읽기 전에 그 이름이 바뀌어 없으면 500이 아니라 409", async () => {
    const g = await setupGroup(2);
    const target = g.people[0]!;
    // 넣는 batch와 다시 읽기 사이에 다른 기기가 이름을 바꾼 경합을 흉내 낸다. 요청 하나 안에서는 끼어들 틈이 없어,
    // 넣자마자 이름 키를 바꾸는 트리거로 "다시 읽을 때는 그 이름이 없는" 상태를 만든다.
    await env.DB.prepare(
      `CREATE TRIGGER rename_on_reinsert AFTER INSERT ON participants
       WHEN NEW.name = '새사람'
       BEGIN UPDATE participants SET name_key = name_key || '-moved' WHERE id = NEW.id; END`,
    ).run();
    try {
      const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/participants`, {
        requestId: requestId(),
        names: [target.name, "새사람"],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body.error.code).toBe("STATE_CONFLICT");
    } finally {
      await env.DB.prepare("DROP TRIGGER rename_on_reinsert").run();
    }
  });
});
