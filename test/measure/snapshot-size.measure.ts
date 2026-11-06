import { expect, it } from "vitest";
import { buildDemoSnapshot } from "../../src/shared/demo";
import { personForms, rankAndSearch, trends } from "../../src/shared/insights";
import { seasonSummary } from "../../src/shared/seasonAwards";
import { personDetail, personRecords, placements } from "../../src/shared/stats";
import { standings, titleBandsOf } from "../../src/shared/titles";
import type { Snapshot } from "../../src/shared/types";

// 운영자 스냅숏 응답 크기와 기기 통계 계산 시간 측정(docs/구현현황.md "응답 크기 기준").
// 로컬 서버가 떠 있어야 한다(npm run dev). 로컬 D1에 합성 모임을 만든다. 운영 주소에는 쓰지 않는다.
// 실행: npx vitest run --config vitest.measure.config.ts --silent=false

const BASE = process.env.MEASURE_BASE ?? "http://127.0.0.1:8787";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(BASE)) throw new Error(`로컬 주소가 아닙니다: ${BASE}`);

async function request(cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);
  return response;
}

/** gzip 압축 뒤 바이트 수(웹 표준 CompressionStream). */
async function gzipBytes(text: string): Promise<number> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** 화면이 스냅숏을 받은 뒤 하는 계산 묶음(기록·랭킹·개인 통계·흐름·칭호·연도 요약). */
function computeAll(snapshot: Snapshot): void {
  const names = new Map(snapshot.participants.map((p) => [p.id, p.name]));
  const nameOf = (id: string) => names.get(id) ?? "?";
  const records = personRecords(snapshot.matches);
  rankAndSearch([...records.values()], placements(snapshot.matches), nameOf, "rate", "");
  personForms(snapshot.matches);
  trends(snapshot.matches, nameOf);
  standings(snapshot.matches, titleBandsOf(snapshot.group.settings));
  for (const id of [...records.keys()].slice(0, 5)) personDetail(snapshot.matches, id, nameOf);
  seasonSummary(snapshot, { kind: "year", year: 2026 }, nameOf, new Date("2026-11-06T00:00:00Z"));
}

it("경기 500·2000·5000개의 운영자 스냅숏 크기와 통계 계산 시간", { timeout: 1_200_000 }, async () => {
  const lines: string[] = [];
  for (const count of [500, 2000, 5000]) {
    const login = await fetch(`${BASE}/api/auth/fake-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: `measure-${count}-${Date.now().toString(36)}` }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const group = (await (await request(cookie, "POST", "/api/groups", { name: `측정 ${count}` })).json()) as { id: string };
    const demo = buildDemoSnapshot({ matches: count });
    const created = (await (
      await request(cookie, "POST", `/api/groups/${group.id}/participants`, {
        names: demo.participants.map((p) => p.name),
      })
    ).json()) as { participants: { id: string; name: string }[] };
    const idOf = new Map(demo.participants.map((p) => [p.id, created.participants.find((c) => c.name === p.name)!.id]));
    const matches = demo.matches.map((m) => ({
      playedAt: m.playedAt,
      roster: m.roster.map((r) => ({ ...r, participantId: idOf.get(r.participantId)! })),
      winnerTeam: m.winnerTeam,
      winnerSide: m.teamASide === "unknown" ? "unknown" : m.winnerTeam === "A" ? m.teamASide : m.teamASide === "blue" ? "red" : "blue",
    }));
    for (let i = 0; i < matches.length; i += 50) {
      await request(cookie, "POST", `/api/groups/${group.id}/matches/import`, {
        requestId: `measure-${group.id}-${i}`,
        batchId: `measure-${group.id}`,
        matches: matches.slice(i, i + 50),
      });
    }
    const started = performance.now();
    const text = await (await request(cookie, "GET", `/api/groups/${group.id}/snapshot`)).text();
    const fetchMs = performance.now() - started;
    const bytes = new TextEncoder().encode(text).byteLength;
    const gzip = await gzipBytes(text);
    const parseTimes: number[] = [];
    const computeTimes: number[] = [];
    let snapshot: Snapshot | null = null;
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      snapshot = JSON.parse(text) as Snapshot;
      const t1 = performance.now();
      computeAll(snapshot);
      computeTimes.push(performance.now() - t1);
      parseTimes.push(t1 - t0);
    }
    expect(snapshot!.matches).toHaveLength(count);
    lines.push(
      `| ${count} | ${(bytes / 1024).toFixed(0)} KB | ${(gzip / 1024).toFixed(0)} KB | ${fetchMs.toFixed(0)} ms | ${median(parseTimes).toFixed(1)} ms | ${median(computeTimes).toFixed(1)} ms |`,
    );
  }
  console.log(
    ["| 경기 수 | 응답(원본) | gzip | 로컬 응답 시간 | JSON 해석 | 통계 계산 |", "|---|---|---|---|---|---|", ...lines].join("\n"),
  );
});
