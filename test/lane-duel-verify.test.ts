import { describe, expect, it } from "vitest";
import { LANE_RIVAL_MIN, laneDuelSplit, laneRivals, laneRivalSummary, pairRecord } from "../src/shared/headToHead";
import { laneMatchups } from "../src/shared/prepTools";
import { POSITIONS, type MatchState, type MatchView, type Position, type Side, type Team } from "../src/shared/types";

// 같은 라인 맞대결 통계(두 사람 비교·개인 통계 맞라인 상대·분석 코멘트·준비 화면)를 무작위 경기로 검증한다.
// 화면 함수와 따로, 경기마다 맞선 두 사람을 하나씩 세는 단순 계산(정답표)을 만들어 모든 쌍을 견준다.
// 무작위는 씨앗을 고정해 실패가 재현되게 한다.

const PLAYERS = 16;
const MATCHES = 600;
/** 포지션 기록이 빠진 사람의 비율(지난 경기 입력·이관 경기). */
const NULL_POSITION_RATE = 0.08;
/** 세지 않는 경기(진행 중·결과 대기·취소·제외, 또는 확정인데 승자 없음)의 비율. */
const NOT_COUNTED_RATE = 0.15;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const playerIds = Array.from({ length: PLAYERS }, (_, i) => `p${String(i).padStart(2, "0")}`);

function randomMatches(seed: number): MatchView[] {
  const rand = rng(seed);
  const otherStates: MatchState[] = ["in_progress", "awaiting_result", "canceled", "excluded"];
  const sides: (Side | null)[] = ["blue", "red", "unknown", null];
  return Array.from({ length: MATCHES }, (_, n) => {
    const ten = shuffled(playerIds, rand).slice(0, 10);
    const posA = shuffled(POSITIONS, rand);
    const posB = shuffled(POSITIONS, rand);
    const pos = (p: Position) => (rand() < NULL_POSITION_RATE ? null : p);
    let state: MatchState = "confirmed";
    let winnerTeam: Team | null = rand() < 0.5 ? "A" : "B";
    if (rand() < NOT_COUNTED_RATE) {
      if (rand() < 0.3) winnerTeam = null;
      else state = otherStates[Math.floor(rand() * otherStates.length)]!;
    }
    const at = new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString();
    return {
      id: `m${n}`,
      matchNo: n + 1,
      sessionId: "s1",
      state,
      source: "live",
      startedAt: at,
      endedAt: at,
      playedAt: at,
      confirmedAt: state === "confirmed" ? at : null,
      winnerTeam,
      teamASide: sides[Math.floor(rand() * sides.length)]!,
      version: 1,
      // 팀 B를 먼저 넣는 경기도 섞어 명단 순서에 기대지 않는지 본다.
      roster: shuffled(
        [
          ...ten.slice(0, 5).map((id, i) => ({ participantId: id, team: "A" as Team, position: pos(posA[i]!) })),
          ...ten.slice(5).map((id, i) => ({ participantId: id, team: "B" as Team, position: pos(posB[i]!) })),
        ],
        rand,
      ),
    } satisfies MatchView;
  });
}

type Tally = { games: number; wins: number; losses: number };

/** 정답표: [a][b][라인] = a 기준 같은 라인 맞대결, 그리고 상대 경기 전체·다른 라인·포지션 모름. */
function oracle(matches: readonly MatchView[]) {
  const duel = new Map<string, Tally>();
  const against = new Map<string, Tally>();
  const otherLine = new Map<string, number>();
  const unknown = new Map<string, number>();
  const bump = (m: Map<string, Tally>, key: string, won: boolean) => {
    const t = m.get(key) ?? { games: 0, wins: 0, losses: 0 };
    t.games += 1;
    if (won) t.wins += 1;
    else t.losses += 1;
    m.set(key, t);
  };
  for (const match of matches) {
    if (match.state !== "confirmed" || match.winnerTeam === null) continue;
    for (const x of match.roster) {
      for (const y of match.roster) {
        if (x.participantId === y.participantId || x.team === y.team) continue;
        const pair = `${x.participantId}|${y.participantId}`;
        const won = x.team === match.winnerTeam;
        bump(against, pair, won);
        if (x.position === null || y.position === null) unknown.set(pair, (unknown.get(pair) ?? 0) + 1);
        else if (x.position !== y.position) otherLine.set(pair, (otherLine.get(pair) ?? 0) + 1);
        else bump(duel, `${pair}|${x.position}`, won);
      }
    }
  }
  return { duel, against, otherLine, unknown };
}

const zero: Tally = { games: 0, wins: 0, losses: 0 };

describe.each([1, 2, 3, 20261115])("같은 라인 맞대결 무작위 검증(씨앗 %i)", (seed) => {
  const matches = randomMatches(seed);
  const truth = oracle(matches);

  it("두 사람 비교(laneDuelSplit): 모든 쌍·라인의 판수·승패가 정답표와 같고, 세 갈래 합이 상대 경기 수와 같다", () => {
    let checkedDuels = 0;
    for (const a of playerIds) {
      for (const b of playerIds) {
        if (a === b) continue;
        const split = laneDuelSplit(matches, a, b);
        const expected = POSITIONS.flatMap((p) => {
          const t = truth.duel.get(`${a}|${b}|${p}`);
          return t ? [{ position: p, ...t }] : [];
        });
        expect(split.duels).toEqual(expected);
        expect(split.otherLine).toBe(truth.otherLine.get(`${a}|${b}`) ?? 0);
        expect(split.positionUnknown).toBe(truth.unknown.get(`${a}|${b}`) ?? 0);
        const against = pairRecord(matches, a, b).against;
        expect(against).toEqual(truth.against.get(`${a}|${b}`) ?? zero);
        const sameLine = split.duels.reduce((s, d) => s + d.games, 0);
        expect(sameLine + split.otherLine + split.positionUnknown).toBe(against.games);
        checkedDuels += sameLine;
      }
    }
    // 검증이 빈 자료로 통과하지 않았는지: 맞대결이 실제로 충분히 있었다.
    expect(checkedDuels).toBeGreaterThan(500);
  });

  it("a 기준 승 = b 기준 패(대칭)", () => {
    for (const a of playerIds) {
      for (const b of playerIds) {
        if (a >= b) continue;
        const ab = laneDuelSplit(matches, a, b).duels;
        const ba = laneDuelSplit(matches, b, a).duels;
        expect(ba).toEqual(ab.map((d) => ({ position: d.position, games: d.games, wins: d.losses, losses: d.wins })));
      }
    }
  });

  it("개인 통계 맞라인 상대(laneRivals): 사람마다 모든 상대·라인이 정답표와 같고, 두 사람 비교 숫자와도 같다", () => {
    for (const me of playerIds) {
      const rivals = laneRivals(matches, me);
      const expected = [...truth.duel.entries()]
        .filter(([key]) => key.startsWith(`${me}|`))
        .map(([key, t]) => {
          const [, opponentId, position] = key.split("|");
          return { position: position as Position, opponentId: opponentId!, ...t };
        });
      const sortKey = (r: { position: Position; opponentId: string }) => `${r.position}|${r.opponentId}`;
      expect([...rivals].sort((x, y) => sortKey(x).localeCompare(sortKey(y)))).toEqual(
        expected.sort((x, y) => sortKey(x).localeCompare(sortKey(y))),
      );
      // 정렬: 라인 순 → 경기 수 많은 순.
      for (let i = 1; i < rivals.length; i++) {
        const prev = rivals[i - 1]!;
        const cur = rivals[i]!;
        const order = POSITIONS.indexOf(prev.position) - POSITIONS.indexOf(cur.position);
        expect(order < 0 || (order === 0 && prev.games >= cur.games)).toBe(true);
      }
      for (const r of rivals) {
        const fromCompare = laneDuelSplit(matches, me, r.opponentId).duels.find((d) => d.position === r.position);
        expect(fromCompare).toEqual({ position: r.position, games: r.games, wins: r.wins, losses: r.losses });
      }
    }
  });

  it("가장 어려운·쉬운 상대(laneRivalSummary): 기준 경기 수 이상 중 50% 미만 최저·50% 이상 최고를 고른다", () => {
    for (const me of playerIds) {
      const rivals = laneRivals(matches, me);
      for (const pick of laneRivalSummary(rivals)) {
        const pool = rivals.filter((r) => r.position === pick.position && r.games >= LANE_RIVAL_MIN);
        const rate = (r: Tally) => r.wins / r.games;
        const losing = pool.filter((r) => rate(r) < 0.5);
        const winning = pool.filter((r) => rate(r) >= 0.5);
        if (losing.length === 0) expect(pick.hardest).toBeNull();
        else {
          const worst = Math.min(...losing.map(rate));
          const most = Math.max(...losing.filter((r) => rate(r) === worst).map((r) => r.games));
          expect(rate(pick.hardest!)).toBe(worst);
          expect(pick.hardest!.games).toBe(most);
        }
        if (winning.length === 0) expect(pick.easiest).toBeNull();
        else {
          const best = Math.max(...winning.map(rate));
          const most = Math.max(...winning.filter((r) => rate(r) === best).map((r) => r.games));
          expect(rate(pick.easiest!)).toBe(best);
          expect(pick.easiest!.games).toBe(most);
        }
      }
    }
  });

  it("준비 화면(laneMatchups)은 라인과 무관한 상대 전적 전체를 보인다(같은 라인 맞대결이 아님)", () => {
    const ten = playerIds.slice(0, 10);
    const draft = {
      people: ten.map((id) => ({ key: id, participantId: id })),
      slots: ten.map((id, i) => ({ key: id, team: (i < 5 ? "A" : "B") as Team, position: POSITIONS[i % 5]! })),
    } as unknown as Parameters<typeof laneMatchups>[0];
    for (const row of laneMatchups(draft, matches)) {
      const all = truth.against.get(`${row.leftKey}|${row.rightKey}`) ?? zero;
      const same = truth.duel.get(`${row.leftKey}|${row.rightKey}|${row.position}`) ?? zero;
      expect({ games: row.games, wins: row.wins, losses: row.losses }).toEqual(all);
      // 두 수가 실제로 다르다는 것을 기록해 둔다(같은 라인만 세면 더 작다).
      expect(same.games).toBeLessThanOrEqual(all.games);
    }
  });
});
