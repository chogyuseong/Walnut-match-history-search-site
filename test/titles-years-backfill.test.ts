import { describe, expect, it } from "vitest";
import {
  backfillProblems,
  backfillRequest,
  emptyBackfillForm,
  winnerSideOf,
  type BackfillForm,
} from "../src/shared/backfill";
import { createDraft, swapSides, undoDraft, type Draft, type DraftPerson } from "../src/shared/draft";
import { drawStatus, drawSupport, type RotationContext } from "../src/shared/rotation";
import {
  localYear,
  matchesInScope,
  matchYears,
  personRecords,
  scopeLabel,
  todayMatches,
  zonedTimeToUtc,
} from "../src/shared/stats";
import {
  bandRangeText,
  DEFAULT_TITLE_BANDS,
  parseTitleBands,
  standings,
  titleBandsOf,
  titleFor,
} from "../src/shared/titles";
import type { MatchView, Position, Snapshot, Team } from "../src/shared/types";
import {
  api,
  matchAction,
  playConfirmed,
  requestId,
  rosterOf,
  setupGroup,
  snapshot,
  start,
} from "./helpers";

// 괄호 안 번호는 docs/P4 P4-5의 검증 시나리오 번호다.

const POS: Position[] = ["top", "jungle", "mid", "adc", "support"];

/** id0~4가 팀 A, id5~9가 팀 B인 경기. */
function match(
  no: number,
  winner: Team | null,
  options: { state?: MatchView["state"]; playedAt?: string; sessionId?: string | null } = {},
): MatchView {
  const state = options.state ?? (winner ? "confirmed" : "awaiting_result");
  const playedAt = options.playedAt ?? "2026-10-10T03:00:00.000Z";
  return {
    id: `m${no}`,
    matchNo: no,
    sessionId: options.sessionId === undefined ? "s1" : options.sessionId,
    state,
    source: "live",
    startedAt: playedAt,
    endedAt: playedAt,
    playedAt,
    confirmedAt: state === "confirmed" ? playedAt : null,
    winnerTeam: winner,
    teamASide: winner ? "unknown" : null,
    version: 1,
    roster: Array.from({ length: 10 }, (_, i) => ({
      participantId: `id${i}`,
      team: (i < 5 ? "A" : "B") as Team,
      position: POS[i % 5]!,
    })),
  };
}

function snap(matches: MatchView[], seasons: Snapshot["seasons"] = []): Snapshot {
  return {
    role: "viewer",
    serverTime: "2026-11-05T00:00:00.000Z",
    group: {
      id: "g",
      name: "모임",
      timezone: "Asia/Seoul",
      liveVersion: 0,
      settings: { rotationEnabled: true, groupsPublic: false, groupWeights: [0, 0, 0, 0, 0] },
    },
    participants: Array.from({ length: 10 }, (_, i) => ({
      id: `id${i}`,
      name: `참가자${i}`,
      status: "active" as const,
    })),
    session: null,
    rotation: null,
    matches,
    revisions: [],
    seasons,
  };
}

/** 팀 A(id0)가 wins번 이기고 나머지는 지는 경기 목록. */
function games(total: number, wins: number, playedAt?: (i: number) => string): MatchView[] {
  return Array.from({ length: total }, (_, i) =>
    match(i + 1, i < wins ? "A" : "B", { playedAt: playedAt?.(i) }),
  );
}

describe("칭호 구간 (P2-11)", () => {
  it("경계는 '이상'이다: 정확히 65%·55%·45%·35%는 위 구간에 들어간다", () => {
    const bands = DEFAULT_TITLE_BANDS;
    // 20경기 기준: 13승=65%, 11승=55%, 9승=45%, 7승=35%
    expect(titleFor(13, 20, bands)?.minRate).toBe(65);
    expect(titleFor(12, 20, bands)?.minRate).toBe(55); // 60%
    expect(titleFor(11, 20, bands)?.minRate).toBe(55);
    expect(titleFor(9, 20, bands)?.minRate).toBe(45);
    expect(titleFor(7, 20, bands)?.minRate).toBe(35);
    expect(titleFor(6, 20, bands)?.minRate).toBe(0); // 30%
    expect(titleFor(0, 20, bands)?.minRate).toBe(0);
    // 소수 오차가 나기 쉬운 값: 64.99…%는 65% 구간이 아니다.
    expect(titleFor(649, 1000, bands)?.minRate).toBe(55);
    expect(titleFor(650, 1000, bands)?.minRate).toBe(65);
    // 35%는 11/31처럼 나눠 떨어지지 않아도 곱셈으로 비교한다.
    expect(titleFor(7, 20, bands)?.name).toBe("끈질긴 전사");
  });

  it("가장 낮은 경계보다 낮으면 칭호가 없고, 칭호를 쓰지 않으면 아무도 없다", () => {
    const bands = [
      { minRate: 60, name: "상위" },
      { minRate: 40, name: "중위" },
    ];
    expect(titleFor(3, 10, bands)).toBeNull();
    expect(titleFor(10, 10, [])).toBeNull();
  });

  it("저장한 적 없으면 기본값, 빈 목록으로 저장했으면 빈 채로 둔다", () => {
    expect(titleBandsOf({})).toBe(DEFAULT_TITLE_BANDS);
    expect(titleBandsOf({ titleBands: [] })).toEqual([]);
    expect(DEFAULT_TITLE_BANDS.map((b) => b.minRate)).toEqual([65, 55, 50, 45, 35, 0]);
  });

  it("구간 값을 검사하고 높은 구간부터 정렬한다", () => {
    const ok = parseTitleBands([
      { minRate: 0, name: " 막내 " },
      { minRate: 70, name: "최고" },
    ]);
    expect(ok).toEqual({
      ok: true,
      bands: [
        { minRate: 70, name: "최고" },
        { minRate: 0, name: "막내" },
      ],
    });
    expect(parseTitleBands([{ minRate: 50.5, name: "x" }]).ok).toBe(false);
    expect(parseTitleBands([{ minRate: 101, name: "x" }]).ok).toBe(false);
    expect(parseTitleBands([{ minRate: 50, name: "   " }]).ok).toBe(false);
    expect(parseTitleBands([{ minRate: 50, name: "열세글자가넘는아주긴칭호이름" }]).ok).toBe(false);
    expect(
      parseTitleBands([
        { minRate: 50, name: "a" },
        { minRate: 50, name: "b" },
      ]).ok,
    ).toBe(false);
    expect(parseTitleBands([{ minRate: 50, name: "a", color: "red" }]).ok).toBe(false);
    expect(parseTitleBands(Array.from({ length: 9 }, (_, i) => ({ minRate: i, name: `${i}` }))).ok).toBe(
      false,
    );
    expect(parseTitleBands([]).ok).toBe(true);
  });

  it("구간 글", () => {
    const bands = DEFAULT_TITLE_BANDS;
    expect(bandRangeText(bands, 0)).toBe("65% 이상");
    expect(bandRangeText(bands, 1)).toBe("55% 이상 65% 미만");
    // 50~55% 구간이 추가되고 "든든한 전우"는 45~50%가 됐다(2026-11-06).
    expect(bandRangeText(bands, 2)).toBe("50% 이상 55% 미만");
    expect(bands[3]).toEqual({ minRate: 45, name: "든든한 전우" });
    expect(bandRangeText(bands, 3)).toBe("45% 이상 50% 미만");
    expect(bandRangeText(bands, 5)).toBe("35% 미만");
  });
});

describe("배치와 칭호 (31·32·34·35)", () => {
  it("0판·9판·10판: 진행 중 0/10 · 9/10 · 완료와 칭호 (31)", () => {
    expect(standings([], DEFAULT_TITLE_BANDS).get("id0")).toBeUndefined();
    const nine = standings(games(9, 9), DEFAULT_TITLE_BANDS).get("id0")!;
    expect(nine).toMatchObject({ games: 9, done: false, title: null });
    const ten = standings(games(10, 7), DEFAULT_TITLE_BANDS).get("id0")!;
    expect(ten).toMatchObject({ games: 10, wins: 7, done: true, title: "전장의 지배자" });
    // 팀 B(id5)는 3승 7패 = 30%
    expect(standings(games(10, 7), DEFAULT_TITLE_BANDS).get("id5")?.title).toBe("불굴의 개척자");
  });

  it("10판에서 한 경기를 제외하면 9/10으로 칭호가 사라지고, 복구하면 돌아온다 (32)", () => {
    const all = games(10, 6);
    expect(standings(all, DEFAULT_TITLE_BANDS).get("id0")?.title).toBe("승리 설계자");
    const excluded = all.map((m, i) => (i === 0 ? { ...m, state: "excluded" as const } : m));
    expect(standings(excluded, DEFAULT_TITLE_BANDS).get("id0")).toMatchObject({
      games: 9,
      done: false,
      title: null,
    });
    const restored = excluded.map((m, i) => (i === 0 ? { ...m, state: "confirmed" as const } : m));
    expect(standings(restored, DEFAULT_TITLE_BANDS).get("id0")).toMatchObject({
      games: 10,
      done: true,
      title: "승리 설계자",
    });
  });

  it("대기 경기는 확정 전에는 세지 않는다 (28)", () => {
    const nine = [...games(9, 9), match(10, null, { state: "awaiting_result" })];
    expect(standings(nine, DEFAULT_TITLE_BANDS).get("id0")).toMatchObject({ games: 9, title: null });
  });

  it("범위(시즌·연도·오늘)를 바꿔도 칭호는 누적 기준 그대로다 (34)", () => {
    // 2025년에 10경기 전승, 2026년에 1경기 패. 누적 11경기 10승 → 91% → 최상위 칭호.
    const all = [
      ...games(10, 10, () => "2025-05-01T03:00:00.000Z"),
      match(11, "B", { playedAt: "2026-03-01T03:00:00.000Z" }),
    ];
    const s = snap(all, [{ id: "s26", name: "26시즌", startsOn: "2026-01-01", endsOn: "2026-12-31" }]);
    const cumulative = standings(s.matches, DEFAULT_TITLE_BANDS).get("id0");
    for (const scope of [
      { kind: "season" as const, seasonId: "s26" },
      { kind: "year" as const, year: 2026 },
      { kind: "today" as const },
    ]) {
      const scoped = matchesInScope(s, scope);
      // 범위 안 성적은 다르다(2026년엔 1경기 0승).
      if (scope.kind !== "today") expect(personRecords(scoped).get("id0")).toMatchObject({ games: 1, wins: 0 });
      // 칭호는 범위 경기로 계산하지 않는다. 화면은 항상 전체 경기로 standings를 부른다.
      expect(standings(s.matches, DEFAULT_TITLE_BANDS).get("id0")).toEqual(cumulative);
    }
    expect(cumulative).toMatchObject({ games: 11, wins: 10, title: "전장의 지배자" });
  });
});

describe("연도별 보기", () => {
  it("연도 경계는 모임 시간대를 따른다", () => {
    // UTC 2025-12-31 15:30은 한국 시간 2026-01-01 00:30이다.
    expect(localYear("2025-12-31T15:30:00.000Z", "Asia/Seoul")).toBe(2026);
    expect(localYear("2025-12-31T14:59:00.000Z", "Asia/Seoul")).toBe(2025);
    // 같은 시각도 뉴욕 기준이면 2025년이다.
    expect(localYear("2025-12-31T15:30:00.000Z", "America/New_York")).toBe(2025);
  });

  it("연도 범위는 그해 경기만 담고, 경기가 있는 연도만 고를 수 있다", () => {
    const s = snap([
      match(1, "A", { playedAt: "2024-06-01T03:00:00.000Z" }),
      match(2, "A", { playedAt: "2025-12-31T14:59:00.000Z" }), // 한국 2025-12-31 23:59
      match(3, "B", { playedAt: "2025-12-31T15:00:00.000Z" }), // 한국 2026-01-01 00:00
      match(4, null, { state: "canceled", playedAt: "2023-01-01T03:00:00.000Z" }),
    ]);
    expect(matchYears(s)).toEqual([2026, 2025, 2024]);
    expect(matchesInScope(s, { kind: "year", year: 2025 }).map((m) => m.matchNo)).toEqual([2]);
    expect(matchesInScope(s, { kind: "year", year: 2026 }).map((m) => m.matchNo)).toEqual([3]);
    // 취소 경기만 있는 해는 고를 수 없고, 골라도 비어 있다.
    expect(matchesInScope(s, { kind: "year", year: 2023 })).toEqual([]);
    expect(scopeLabel(s, { kind: "year", year: 2025 })).toBe("2025년");
  });

  it("모임 시간대의 날짜·시각을 UTC로 바꾼다", () => {
    expect(zonedTimeToUtc("2026-01-01", "00:30", "Asia/Seoul")).toBe("2025-12-31T15:30:00.000Z");
    expect(zonedTimeToUtc("2026-11-05", "21:00", "Asia/Seoul")).toBe("2026-11-05T12:00:00.000Z");
    // 서머타임 전후(뉴욕): 1월은 UTC-5, 7월은 UTC-4
    expect(zonedTimeToUtc("2026-01-15", "20:00", "America/New_York")).toBe("2026-01-16T01:00:00.000Z");
    expect(zonedTimeToUtc("2026-07-15", "20:00", "America/New_York")).toBe("2026-07-16T00:00:00.000Z");
  });
});

describe("좌우 바꾸기 (19)", () => {
  const people: DraftPerson[] = Array.from({ length: 10 }, (_, i) => ({
    key: `p:id${i}`,
    name: `참가자${i}`,
    participantId: `id${i}`,
  }));
  const teamOf: Record<string, Team> = Object.fromEntries(
    people.map((p, i) => [p.key, (i < 5 ? "A" : "B") as Team]),
  );
  const ctx: RotationContext = { enabled: true, cycleId: "c1", usedIds: new Set(), eventCount: 0 };
  const base = (): Draft =>
    createDraft(people, { groupId: "g", baseLiveVersion: 0, seed: 11, now: "2026-11-05T00:00:00Z", teamOf });

  it("양팀 추첨을 마친 뒤 좌우를 바꿔도 두 팀 추첨이 유지된다", () => {
    const drawn = drawSupport(base(), ["A", "B"], ctx).draft;
    expect(drawStatus(drawn, "A", ctx)).toBe("applied");
    expect(drawStatus(drawn, "B", ctx)).toBe("applied");

    const swapped = swapSides(drawn);
    // 팀 구성과 포지션은 그대로이고 이름표만 바뀐다.
    for (const slot of drawn.slots) {
      const after = swapped.slots.find((s) => s.key === slot.key)!;
      expect(after.team).toBe(slot.team === "A" ? "B" : "A");
      expect(after.position).toBe(slot.position);
      expect(after.locked).toBe(slot.locked);
    }
    expect(drawStatus(swapped, "A", ctx)).toBe("applied");
    expect(drawStatus(swapped, "B", ctx)).toBe("applied");
    expect(swapped.draws.A).toEqual(drawn.draws.B);
    expect(swapped.draws.B).toEqual(drawn.draws.A);

    // 다시 누르면 두 팀 모두 새로 뽑는다(2026-11-06 변경: 누를 때마다 새로 뽑는다).
    const again = drawSupport(swapped, ["A", "B"], ctx);
    expect(again.outcomes.map((o) => o.kind)).toEqual(["drawn", "drawn"]);
    for (const team of ["A", "B"] as const) {
      const sup = (d: Draft) => d.slots.find((s) => s.team === team && s.position === "support")!.key;
      expect(sup(again.draft)).not.toBe(sup(swapped));
    }

    // 두 번 바꾸면 원래와 같다.
    expect(swapSides(swapped)).toEqual(drawn);
  });

  it("좌우를 바꾼 뒤 '직전 편성으로'를 눌러도 추첨 기록과 어긋나지 않는다", () => {
    const drawn = drawSupport(base(), ["A", "B"], ctx).draft;
    const undone = undoDraft(swapSides(drawn));
    // 되돌린 편성(추첨 전)은 추첨 기록과 어긋나지 않는다(다시 누르면 새로 뽑는다).
    expect(drawStatus(undone, "A", ctx)).toBe("reapplicable");
    expect(drawStatus(undone, "B", ctx)).toBe("reapplicable");
  });
});

describe("지난 경기 한 건 입력 폼", () => {
  function filled(): BackfillForm {
    const form = emptyBackfillForm("2026-10-01", "21:00");
    form.teams.A = Array.from({ length: 5 }, (_, i) => ({ name: `가${i}`, position: "" as const }));
    form.teams.B = Array.from({ length: 5 }, (_, i) => ({ name: `나${i}`, position: POS[i]! }));
    form.winner = "B";
    form.side = "a-red";
    return form;
  }
  const now = new Date("2026-11-05T00:00:00.000Z");

  it("승리 팀과 팀 A의 진영에서 승리 팀의 진영을 구한다", () => {
    expect(winnerSideOf("A", "a-blue")).toBe("blue");
    expect(winnerSideOf("B", "a-blue")).toBe("red");
    expect(winnerSideOf("B", "a-red")).toBe("blue");
    expect(winnerSideOf("A", "unknown")).toBe("unknown");
  });

  it("빈 이름·중복·같은 포지션·미선택·미래 시각을 알려준다", () => {
    expect(backfillProblems(filled(), "Asia/Seoul", now)).toEqual([]);
    const empty = emptyBackfillForm("2026-10-01", "21:00");
    const problems = backfillProblems(empty, "Asia/Seoul", now);
    expect(problems).toContain("이름이 빈 칸이 10개 있어요.");
    expect(problems).toContain("이긴 팀을 골라 주세요.");
    expect(problems).toContain("진영을 골라 주세요.");

    const dup = filled();
    dup.teams.B[0]!.name = " 가0 ";
    expect(backfillProblems(dup, "Asia/Seoul", now)).toContain("같은 사람이 두 번 들어 있어요: 가0");

    const pos = filled();
    pos.teams.B[1]!.position = "top";
    expect(backfillProblems(pos, "Asia/Seoul", now)).toContain("팀 B에 같은 포지션이 두 번 있어요.");

    const future = filled();
    future.date = "2026-12-01";
    expect(backfillProblems(future, "Asia/Seoul", now)[0]).toContain("아직 오지 않은 시각");
  });

  it("모임 시간대 시각과 포지션 없음(null)으로 요청을 만든다", () => {
    const body = backfillRequest(filled(), "Asia/Seoul", (name) => `id-${name}`);
    expect(body.playedAt).toBe("2026-10-01T12:00:00.000Z");
    expect(body.winnerTeam).toBe("B");
    expect(body.winnerSide).toBe("blue"); // 팀 A 레드 → 이긴 팀 B는 블루
    expect(body.roster).toHaveLength(10);
    expect(body.roster[0]).toEqual({ participantId: "id-가0", team: "A", position: null });
    expect(body.roster[9]).toEqual({ participantId: "id-나4", team: "B", position: "support" });
  });
});

/* ------------------------------------------------------------------ */
/* 서버                                                                 */
/* ------------------------------------------------------------------ */

async function saveSettings(g: Awaited<ReturnType<typeof setupGroup>>, patch: Record<string, unknown>) {
  const snap = await snapshot(g);
  return api(g.cookie, "PUT", `/api/groups/${g.gid}/settings`, {
    requestId: requestId(),
    baseSettingsVersionId: snap.group.settingsVersionId,
    settings: { ...snap.group.settings, ...patch },
  });
}

describe("칭호 설정 (서버)", () => {
  it("새 설정 버전으로 저장하고 조회 링크에도 칭호 구간이 나간다. 비공개 정보는 그대로 숨긴다", async () => {
    const g = await setupGroup();
    const before = await snapshot(g);
    expect(before.group.settings.titleBands).toBeUndefined(); // 저장한 적 없음 → 화면이 기본값을 쓴다

    const bands = [
      { minRate: 0, name: "새싹" },
      { minRate: 60, name: "에이스" },
    ];
    const saved = await saveSettings(g, { titleBands: bands });
    expect(saved.status).toBe(200);
    const after = await snapshot(g);
    expect(after.group.settingsVersionId).not.toBe(before.group.settingsVersionId);
    expect(after.group.settings.titleBands).toEqual([
      { minRate: 60, name: "에이스" },
      { minRate: 0, name: "새싹" },
    ]);

    const view = await api(null, "GET", `/api/view/${after.group.viewToken}`);
    expect(view.status).toBe(200);
    expect(view.body.group.settings.titleBands).toEqual(after.group.settings.titleBands);
    const text = JSON.stringify(view.body);
    expect(text).not.toContain(after.group.viewToken!);
    expect(text).not.toContain(after.group.settingsVersionId!);
    expect(view.body.group.settings.groupWeights).toEqual([0, 0, 0, 0, 0]);
    expect(view.body.participants[0]).not.toHaveProperty("skillGroup");

    // 다른 설정만 바꿔도 칭호는 그대로 이어진다(전체 스냅샷 저장).
    await saveSettings(g, { rotationEnabled: false });
    expect((await snapshot(g)).group.settings.titleBands).toEqual(after.group.settings.titleBands);

    // 칭호를 쓰지 않기로 하면 빈 목록이 저장되고 기본값으로 돌아가지 않는다.
    await saveSettings(g, { titleBands: [] });
    expect((await snapshot(g)).group.settings.titleBands).toEqual([]);
    const emptyView = await api(null, "GET", `/api/view/${after.group.viewToken}`);
    expect(emptyView.body.group.settings.titleBands).toEqual([]);
  });

  it("틀린 칭호 구간은 거절하고 설정을 바꾸지 않는다", async () => {
    const g = await setupGroup(1);
    const before = await snapshot(g);
    for (const titleBands of [
      [{ minRate: 50.5, name: "x" }],
      [{ minRate: 50, name: "" }],
      [
        { minRate: 50, name: "a" },
        { minRate: 50, name: "b" },
      ],
      "65,55",
    ]) {
      const res = await saveSettings(g, { titleBands });
      expect(res.status).toBe(400);
    }
    expect((await snapshot(g)).group.settingsVersionId).toBe(before.group.settingsVersionId);
  });

  it("10판에서 전적 제외 → 복구하면 칭호가 사라졌다가 돌아온다 (32)", async () => {
    const g = await setupGroup();
    await saveSettings(g, { rotationEnabled: false });
    const roster = rosterOf(g.people);
    const played: MatchView[] = [];
    for (let i = 0; i < 10; i++) played.push(await playConfirmed(g, roster, "A", "blue"));
    const id0 = g.people[0]!.id;
    const titleOf = async () => {
      const s = await snapshot(g);
      return standings(s.matches, titleBandsOf(s.group.settings)).get(id0);
    };
    expect(await titleOf()).toMatchObject({ games: 10, done: true, title: "전장의 지배자" });

    const excluded = await matchAction(g, played[0]!, "exclude");
    expect(excluded.status).toBe(200);
    expect(await titleOf()).toMatchObject({ games: 9, done: false, title: null });

    const restored = await matchAction(g, excluded.body.match, "restore");
    expect(restored.status).toBe(200);
    expect(await titleOf()).toMatchObject({ games: 10, done: true, title: "전장의 지배자" });
  });
});

describe("지난 경기 한 건 입력 (서버)", () => {
  it("열린 내전·순환·진행 중 경기를 건드리지 않고, 오늘의 결과에도 들어가지 않는다", async () => {
    const g = await setupGroup();
    const roster = rosterOf(g.people);
    await playConfirmed(g, roster);
    // 서포터를 바꿔 반복 확인 없이 두 번째 경기를 진행 중으로 둔다.
    const second = roster.map((r, i) =>
      i === 3 || i === 8 ? { ...r, position: "support" as const } : i === 4 || i === 9 ? { ...r, position: "adc" as const } : r,
    );
    expect((await start(g, second)).status).toBe(200);
    const before = await snapshot(g);
    expect(before.session).not.toBeNull();

    const res = await api(g.cookie, "POST", `/api/groups/${g.gid}/matches/backfill`, {
      requestId: requestId(),
      playedAt: zonedTimeToUtc("2026-10-01", "21:00", before.group.timezone),
      roster: roster.map((r, i) => ({ ...r, position: i % 2 === 0 ? r.position : null })),
      winnerTeam: "A",
      winnerSide: winnerSideOf("A", "a-red"),
    });
    expect(res.status).toBe(200);
    expect(res.body.match).toMatchObject({
      state: "confirmed",
      source: "backfill",
      sessionId: null,
      teamASide: "red",
    });

    const after = await snapshot(g);
    expect(after.session).toEqual(before.session);
    expect(after.rotation).toEqual(before.rotation);
    expect(after.group.liveVersion).toBe(before.group.liveVersion);
    expect(after.matches.filter((m) => m.state === "in_progress").map((m) => m.id)).toEqual(
      before.matches.filter((m) => m.state === "in_progress").map((m) => m.id),
    );
    // 오늘의 결과(가장 최근 세션)에는 들어가지 않고 누적 기록에는 들어간다.
    expect(todayMatches(after).some((m) => m.id === res.body.match.id)).toBe(false);
    expect(personRecords(after.matches).get(g.people[0]!.id)?.games).toBe(2);
    // 2026년 연도 범위에 들어간다(모임 시간대 기준).
    expect(matchesInScope(after, { kind: "year", year: 2026 }).some((m) => m.id === res.body.match.id)).toBe(true);
  });
});
