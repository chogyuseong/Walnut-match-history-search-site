import { expect, it } from "vitest";
import { buildDemoSnapshot } from "../../src/shared/demo";
import { personForms, rankAndSearch, trends } from "../../src/shared/insights";
import { seasonSummary } from "../../src/shared/seasonAwards";
import { personDetail, personRecords } from "../../src/shared/stats";
import { DEFAULT_TITLE_BANDS, standings, titleBandsOf } from "../../src/shared/titles";
import type { Snapshot } from "../../src/shared/types";

// 운영자 스냅숏 응답 크기와 기기 통계 계산 시간 측정(docs/구현현황/2026-11-05.md "응답 크기 기준").
// 로컬 서버가 떠 있어야 한다(npm run dev). 로컬 D1에 합성 모임을 만든다. 운영 주소에는 쓰지 않는다.
// 실행: npx vitest run --config vitest.measure.config.ts --silent=false
// "같은 경기 다시 받음"은 결과 저장 뒤처럼 새 스냅숏이 같은 경기 열로 올 때다. MMR은 지난 계산에서 이어 넣어(rating.ts FitState) 빠르다.

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
  rankAndSearch([...records.values()], standings(snapshot.matches, DEFAULT_TITLE_BANDS), nameOf, "rate", "");
  personForms(snapshot.matches);
  trends(snapshot.matches, nameOf);
  standings(snapshot.matches, titleBandsOf(snapshot.group.settings));
  for (const id of [...records.keys()].slice(0, 5)) personDetail(snapshot.matches, id, nameOf);
  seasonSummary(snapshot, { kind: "year", year: 2026 }, nameOf, new Date("2026-11-06T00:00:00Z"));
}

/** 예시 모임 경기 count개를 가져오기로 넣은 측정용 모임을 만든다. 참가자 ID는 서버가 새로 매긴 것이다. */
async function seedGroup(count: number): Promise<{ cookie: string; groupId: string; participantIds: string[] }> {
  const login = await fetch(`${BASE}/api/auth/fake-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subject: `measure-${count}-${Date.now().toString(36)}` }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const group = (await (await request(cookie, "POST", "/api/groups", { requestId: crypto.randomUUID(), name: `측정 ${count}` })).json()) as { id: string };
  const demo = buildDemoSnapshot({ matches: count });
  const created = (await (
    await request(cookie, "POST", `/api/groups/${group.id}/participants`, {
      requestId: crypto.randomUUID(),
      names: demo.participants.map((p) => p.name),
    })
  ).json()) as { participants: { id: string; name: string }[] };
  const idOf = new Map(demo.participants.map((p) => [p.id, created.participants.find((c) => c.name === p.name)!.id]));
  const matches = demo.matches.map((m) => ({
    playedAt: m.playedAt,
    // 가져오기는 챔피언을 받지 않는다(챔피언은 결과 입력에서만 적는다).
    roster: m.roster.map((r) => ({ participantId: idOf.get(r.participantId)!, team: r.team, position: r.position })),
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
  return { cookie, groupId: group.id, participantIds: [...idOf.values()] };
}

it("경기 500·2000·5000개의 운영자 스냅숏 크기와 통계 계산 시간", { timeout: 1_200_000 }, async () => {
  const lines: string[] = [];
  for (const count of [500, 2000, 5000]) {
    const { cookie, groupId } = await seedGroup(count);
    const group = { id: groupId };
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
      `| ${count} | ${(bytes / 1024).toFixed(0)} KB | ${(gzip / 1024).toFixed(0)} KB | ${fetchMs.toFixed(0)} ms | ${median(parseTimes).toFixed(1)} ms | ${computeTimes[0]!.toFixed(1)} ms | ${median(computeTimes.slice(1)).toFixed(1)} ms |`,
    );
  }
  console.log(
    [
      "| 경기 수 | 응답(원본) | gzip | 로컬 응답 시간 | JSON 해석 | 통계 계산(처음) | 통계 계산(같은 경기 다시 받음) |",
      "|---|---|---|---|---|---|---|",
      ...lines,
    ].join("\n"),
  );
});

/** 결과 저장 한 번을 몇 번 되풀이해 중앙값을 낼지. 첫 번은 서버·JIT가 데워지지 않아 튄다. */
const SAVE_ROUNDS = 5;
const LINE_ORDER = ["top", "jungle", "mid", "adc", "support"] as const;

// 운영자가 결과를 저장했을 때 화면이 새 기록을 그리기까지의 단계별 시간(ResultSheet.tsx save → refreshAfterOwnChange).
// 결과 저장 POST, 스냅숏 전체 GET, JSON 해석, 통계 계산(새 경기 하나가 붙은 경기 열이라 MMR은 이어서 계산)을 나눠 잰다.
// 경기 시작도 같은 다시 읽기를 하지만 확정 경기 열이 그대로라 계산은 더 가볍다. 여기서는 결과 저장만 본다.
it("결과 저장 뒤 다시 읽기: 단계별 시간(경기 600·2000개)", { timeout: 1_200_000 }, async () => {
  const lines: string[] = [];
  for (const count of [600, 2000]) {
    const { cookie, groupId, participantIds } = await seedGroup(count);
    const readSnapshot = async () => {
      const t0 = performance.now();
      const text = await (await request(cookie, "GET", `/api/groups/${groupId}/snapshot`)).text();
      const fetchMs = performance.now() - t0;
      const t1 = performance.now();
      const snapshot = JSON.parse(text) as Snapshot;
      const parseMs = performance.now() - t1;
      const t2 = performance.now();
      computeAll(snapshot);
      return { snapshot, text, fetchMs, parseMs, computeMs: performance.now() - t2 };
    };
    // 화면을 처음 연 상태(MMR 처음 계산)를 만들어 둔다.
    let current = await readSnapshot();
    // 판마다 두 칸씩 밀어 서포터가 겹치지 않게 한다(서포터 순환이 같은 사람의 두 번째 서폿을 409로 막는다).
    const rosterFor = (round: number) =>
      participantIds.slice(round * 2, round * 2 + 10).map((participantId, i) => ({
        participantId,
        team: i < 5 ? "A" : "B",
        position: LINE_ORDER[i % 5],
      }));
    const saves: number[] = [];
    const fetches: number[] = [];
    const parses: number[] = [];
    const computes: number[] = [];
    for (let round = 0; round < SAVE_ROUNDS; round++) {
      const started = (await (
        await request(cookie, "POST", `/api/groups/${groupId}/matches/start`, {
          requestId: crypto.randomUUID(),
          baseLiveVersion: current.snapshot.group.liveVersion,
          roster: rosterFor(round),
        })
      ).json()) as { match: { id: string; version: number } };
      // 화면이 경기 시작 뒤에도 다시 읽는다. 시간은 세지 않고, MMR 이어서 계산의 출발점만 맞춘다.
      await readSnapshot();
      const t0 = performance.now();
      await request(cookie, "POST", `/api/groups/${groupId}/matches/${started.match.id}/result`, {
        requestId: crypto.randomUUID(),
        baseMatchVersion: started.match.version,
        winnerTeam: round % 2 === 0 ? "A" : "B",
        winnerSide: "blue",
      });
      saves.push(performance.now() - t0);
      current = await readSnapshot();
      fetches.push(current.fetchMs);
      parses.push(current.parseMs);
      computes.push(current.computeMs);
    }
    const gzip = await gzipBytes(current.text);
    lines.push(
      `| ${count} | ${median(saves).toFixed(0)} ms | ${median(fetches).toFixed(0)} ms | ${(gzip / 1024).toFixed(0)} KB | ${median(parses).toFixed(1)} ms | ${median(computes).toFixed(1)} ms |`,
    );
  }
  console.log(
    [
      "| 경기 수 | 결과 저장 POST | 스냅숏 GET | gzip | JSON 해석 | 통계 계산 |",
      "|---|---|---|---|---|---|",
      ...lines,
    ].join("\n"),
  );
});
