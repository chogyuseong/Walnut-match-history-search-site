import { describe, expect, it } from "vitest";
import { createDraft, type DraftPerson } from "../src/shared/draft";
import { pairOutcome, pairRecord } from "../src/shared/headToHead";
import { headToHead } from "../src/shared/insights";
import { lastMatchPeople, lastSessionPeople } from "../src/shared/lastPick";
import { laneMatchups } from "../src/shared/prepTools";
import { sessionSummary, sessionSummaryText } from "../src/shared/sessionSummary";
import { POSITIONS, type MatchState, type MatchView, type ParticipantView, type Team } from "../src/shared/types";

// 사용자 편의 기능(2026-11-07)의 순수 로직: 상대 전적(headToHead.ts), 오늘 요약(sessionSummary.ts),
// 지난 내전 참가자 그대로(lastPick.ts lastSessionPeople).

let seq = 0;
function match(
  teamA: string[],
  teamB: string[],
  winner: Team | null,
  opts: { state?: MatchState; sessionId?: string | null; source?: MatchView["source"]; playedAt?: string } = {},
): MatchView {
  seq += 1;
  const state = opts.state ?? "confirmed";
  const playedAt = opts.playedAt ?? `2026-11-07T10:${String(seq % 60).padStart(2, "0")}:00.000Z`;
  return {
    id: `m${seq}`,
    matchNo: seq,
    sessionId: opts.sessionId === undefined ? "s1" : opts.sessionId,
    state,
    source: opts.source ?? "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: state === "confirmed" ? playedAt : null,
    winnerTeam: winner,
    teamASide: "blue",
    version: 1,
    roster: [
      ...teamA.map((id, i) => ({ participantId: id, team: "A" as Team, position: POSITIONS[i]! })),
      ...teamB.map((id, i) => ({ participantId: id, team: "B" as Team, position: POSITIONS[i]! })),
    ],
  };
}

const ids = (from: number, n = 5) => Array.from({ length: n }, (_, i) => `id${from + i}`);
const nameOf = (id: string) => `이름${id.slice(2).padStart(2, "0")}`;

describe("상대 전적(headToHead.ts)", () => {
  it("상대 팀·같은 팀 경기를 a 기준으로 세고, 확정되지 않은 경기는 뺀다", () => {
    const ms = [
      match(ids(0), ids(5), "A"), // id0 vs id5: id0 승
      match(ids(0), ids(5), "B"), // id0 패
      match(["id0", "id5", "id1", "id2", "id3"], ids(6), "A"), // 같은 팀 승
      match(ids(0), ids(5), "A", { state: "in_progress" }),
      match(ids(0), ids(5), "A", { state: "excluded" }),
      match(ids(0), ids(5), null, { state: "awaiting_result" }),
    ];
    expect(pairRecord(ms, "id0", "id5")).toEqual({
      against: { games: 2, wins: 1, losses: 1 },
      together: { games: 1, wins: 1 },
    });
    // 반대 기준은 승패가 뒤집힌다.
    expect(pairRecord(ms, "id5", "id0").against).toEqual({ games: 2, wins: 1, losses: 1 });
    expect(pairOutcome(ms[0]!, "id0", "id0")).toBeNull();
    expect(pairOutcome(ms[0]!, "id0", "id99")).toBeNull();
    expect(pairOutcome(ms[3]!, "id0", "id5")).toBeNull();
  });

  it("두 사람 비교(insights headToHead)·라인 맞대결과 같은 수를 낸다", () => {
    const ms = [
      match(ids(0), ids(5), "A"),
      match(ids(5), ids(0), "A"),
      match(["id0", "id5", "id1", "id2", "id3"], ids(6), "B"),
      match(ids(0), ids(5), "B", { state: "canceled" }),
    ];
    const pair = pairRecord(ms, "id0", "id5");
    const h = headToHead(ms, "id0", "id5");
    expect(h.against).toEqual({ games: pair.against.games, aWins: pair.against.wins, bWins: pair.against.losses });
    expect(h.together).toEqual({ games: pair.together.games, wins: pair.together.wins });

    const draftPeople: DraftPerson[] = Array.from({ length: 10 }, (_, i) => ({
      key: `p:id${i}`,
      name: nameOf(`id${i}`),
      participantId: `id${i}`,
    }));
    const teamOf: Record<string, Team> = {};
    draftPeople.forEach((p, i) => (teamOf[p.key] = i < 5 ? "A" : "B"));
    const draft = createDraft(draftPeople, { groupId: "g", baseLiveVersion: 0, seed: 3, now: "2026-11-07T00:00:00.000Z", teamOf });
    for (const lane of laneMatchups(draft, ms)) {
      const left = draft.people.find((p) => p.key === lane.leftKey)!.participantId!;
      const right = draft.people.find((p) => p.key === lane.rightKey)!.participantId!;
      const expected = pairRecord(ms, left, right).against;
      expect({ games: lane.games, wins: lane.wins, losses: lane.losses }).toEqual(expected);
    }
  });
});

describe("오늘 요약(sessionSummary.ts)", () => {
  it("경기 수·승 많은 순 승패·서포터·연승을 모으고 확정 안 된 경기는 빼고 센다", () => {
    const before = match(ids(0), ids(5), "A", { sessionId: "old", playedAt: "2026-11-01T10:00:00.000Z" });
    const today = [
      match(ids(0), ids(5), "A"),
      match(ids(0), ids(5), "A"),
      match(ids(5), ids(0), "A"), // id5~9 승
      match(ids(0), ids(5), null, { state: "in_progress" }),
    ];
    const summary = sessionSummary(today, [before, ...today], nameOf);
    expect(summary.games).toBe(3);
    expect(summary.pending).toBe(1);
    expect(summary.people).toHaveLength(10);
    // id0~4: 2승 1패, id5~9: 1승 2패. 같은 승수는 이름 순.
    expect(summary.people.slice(0, 5).map((p) => [p.participantId, p.wins, p.losses])).toEqual(
      ids(0).map((id) => [id, 2, 1]),
    );
    expect(summary.people[5]).toMatchObject({ participantId: "id5", wins: 1, losses: 2 });
    // 서포터: id4(팀 A 서포터 2번 + 셋째 경기 팀 B 서포터 1번) 3번, id9 3번.
    expect(summary.supporters).toEqual([
      { participantId: "id4", name: "이름04", count: 3 },
      { participantId: "id9", name: "이름09", count: 3 },
    ]);
    // 연승: 마지막 확정 경기에서 id5~9가 이겼으므로 각 1연승 → 2연승 이상은 없다.
    expect(summary.streaks).toEqual([]);
  });

  it("지난 내전까지 이어진 연승을 세고, 글에는 비공개 정보 없이 이름·승패만 쓴다", () => {
    const old = match(ids(0), ids(5), "A", { sessionId: "old", playedAt: "2026-11-01T10:00:00.000Z" });
    const today = [match(ids(0), ids(5), "A"), match(ids(0), ids(5), "A")];
    const summary = sessionSummary(today, [old, ...today], nameOf);
    expect(summary.streaks.map((s) => [s.participantId, s.wins])).toEqual(ids(0).map((id) => [id, 3]));
    const text = sessionSummaryText(summary, "호두 내전", "11월 7일");
    expect(text.split("\n").slice(0, 2)).toEqual(["호두 내전 · 11월 7일 내전 요약", "확정 2경기 · 참가 10명"]);
    expect(text).toContain("이름00 2승 0패");
    expect(text).toContain("이름09 0승 2패");
    expect(text).toContain("서포터: 이름04 2번 · 이름09 2번");
    expect(text).toContain("연승 중: 이름00 3연승");
    expect(text).not.toMatch(/티어|skillGroup|id\d/);
  });

  it("서포터·연승이 없으면 그렇다고 쓰고, 결과를 안 넣은 경기가 있으면 알린다", () => {
    const m = match(ids(0), ids(5), "B");
    m.roster = m.roster.map((r) => ({ ...r, position: null }));
    const pending = match(ids(0), ids(5), null, { state: "awaiting_result" });
    const summary = sessionSummary([m, pending], [m, pending], nameOf);
    const text = sessionSummaryText(summary, "모임", "11월 7일");
    expect(text).toContain("서포터: 기록 없음");
    expect(text).toContain("연승 중: 없음");
    expect(text).toContain("결과를 아직 넣지 않은 1경기는 빠졌어요.");
  });
});

describe("지난 내전 참가자 그대로(lastSessionPeople)", () => {
  const participants: ParticipantView[] = Array.from({ length: 14 }, (_, i) => ({
    id: `id${i}`,
    name: nameOf(`id${i}`),
    status: i === 13 ? "archived" : "active",
  }));

  it("지난 경기가 속한 내전의 모든 실시간 경기 명단을 합치고, 많이 뛴 순 → 지난 경기 → 이름 순으로 둔다", () => {
    const ms = [
      match(ids(0, 5), ids(5, 5), "A", { sessionId: "old" }),
      match(ids(0, 5), ids(5, 5), "A", { sessionId: "s2" }),
      match(["id0", "id1", "id2", "id3", "id10"], ["id5", "id6", "id7", "id8", "id11"], "B", { sessionId: "s2" }),
      match(["id0", "id1", "id2", "id3", "id12"], ["id5", "id6", "id7", "id8", "id13"], "A", { sessionId: "s2" }),
      match(ids(0, 5), ids(5, 5), null, { sessionId: "s2", state: "canceled" }),
      match(ids(0, 5), ids(5, 5), "A", { sessionId: "s2", source: "backfill" }),
    ];
    const found = lastSessionPeople(ms, participants)!;
    expect(found.match.id).toBe(ms[3]!.id);
    expect(found.games).toBe(3);
    // id0~3·5~8: 3경기, id12: 1경기(지난 경기에 있음), id4·9·10·11: 1경기(지난 경기에는 없음, 이름 순), id13은 보관.
    expect(found.people.map((p) => p.participantId)).toEqual([
      "id0", "id1", "id2", "id3", "id5", "id6", "id7", "id8", "id12", "id4", "id9", "id10", "id11",
    ]);
    expect(found.missing).toBe(1);
    expect(found.people[0]).toEqual({ key: "p:id0", name: "이름00", participantId: "id0" });
    // 최대 인원
    expect(lastSessionPeople(ms, participants, 10)!.people).toHaveLength(10);
    // 지난 경기만 보는 기존 버튼과 다르다(같은 날 다른 경기의 사람도 들어온다).
    expect(lastMatchPeople(ms, participants)!.people).toHaveLength(9);
  });

  it("가져온 기록만 있으면 마지막 확정 경기(경기 시각 순, 출처 무관) 한 경기의 명단을 쓴다(2026-11-08)", () => {
    const imported = [
      match(ids(0), ids(5), "A", { source: "import", sessionId: null, playedAt: "2025-05-02T10:00:00.000Z" }),
      // 번호는 크지만 시각이 앞선 경기는 마지막이 아니다.
      match(["id10", "id1", "id2", "id3", "id4"], ids(5), "B", {
        source: "backfill",
        sessionId: null,
        playedAt: "2025-05-01T10:00:00.000Z",
      }),
      match(["id11", "id1", "id2", "id3", "id4"], ids(5), "A", {
        source: "import",
        state: "excluded",
        sessionId: null,
        playedAt: "2025-05-03T10:00:00.000Z",
      }),
    ];
    const found = lastSessionPeople(imported, participants)!;
    expect(found.match.id).toBe(imported[0]!.id);
    expect(found.games).toBe(1);
    expect(found.people.map((p) => p.participantId).sort()).toEqual([...ids(0), ...ids(5)].sort());
    const one = lastMatchPeople(imported, participants)!;
    expect(one.match.id).toBe(imported[0]!.id);
    expect(one.people).toHaveLength(10);
    // 실시간 경기가 하나라도 있으면 그 경기가 우선이다(가져온 경기가 더 늦어도).
    const live = match(ids(0), ids(5), "A", { playedAt: "2025-04-01T10:00:00.000Z" });
    expect(lastMatchPeople([...imported, live], participants)!.match.id).toBe(live.id);
  });

  it("경기가 없거나 확정 경기가 없으면 null, 세션이 없는 예전 경기면 그 경기만 본다", () => {
    expect(lastSessionPeople([], participants)).toBeNull();
    expect(
      lastSessionPeople([match(ids(0), ids(5), null, { source: "import", state: "excluded" })], participants),
    ).toBeNull();
    const legacy = [
      match(ids(0), ids(5), "A", { sessionId: null }),
      match(["id10", "id1", "id2", "id3", "id4"], ids(5), "A", { sessionId: null }),
    ];
    const found = lastSessionPeople(legacy, participants)!;
    expect(found.games).toBe(1);
    expect(found.people.map((p) => p.participantId).sort()).toEqual(
      ["id10", "id1", "id2", "id3", "id4", ...ids(5)].sort(),
    );
  });
});
