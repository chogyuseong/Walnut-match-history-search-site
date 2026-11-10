/**
 * 예시 모임(#/demo)의 합성 데이터. 서버·DB 없이 기기에서 만든다. 화면은 필요할 때만 불러온다(동적 import).
 *
 * - 결정적: 시드 고정 난수라 언제 만들어도 같은 결과다(시각도 고정 날짜 기준, 지금 시각을 쓰지 않는다).
 * - 이름은 사물·자연 낱말로 지은 가짜 이름이다. 실제 사람 이름처럼 보이는 이름, 알려진 닉네임은 쓰지 않는다.
 * - 티어(skillGroup)·기피 라인(avoidPositions)·서포터 보정값은 넣지 않는다(조회 링크 응답과 같은 모양).
 * - 기본 구성: 24명, 경기 약 100개(2026년 3~10월 매주 금요일 2~4경기), 시즌 2개, 메모·시리즈 약간.
 * - 챔피언: 앞쪽 경기는 비워 두고(기록을 나중에 시작한 모임처럼) 그 뒤로도 가끔 빠뜨려, 챔피언 티어 화면의 입력률이
 *   100%가 아니게 한다. 사람마다 라인별로 즐겨 쓰는 챔피언이 있어 "주로 쓴 사람"이 고르게 갈린다.
 */
import {
  DEFAULT_SETTINGS,
  POSITIONS,
  type MatchView,
  type ParticipantView,
  type Position,
  type RosterEntry,
  type SeasonView,
  type SeriesView,
  type Side,
  type Snapshot,
  type Team,
} from "./types";

export const DEMO_GROUP_NAME = "예시 모임";

const NAMES = [
  "도토리",
  "솔방울",
  "밤송이",
  "새벽별",
  "구름빵",
  "물방울",
  "단풍잎",
  "호두알",
  "보름달",
  "풀잎",
  "모래성",
  "눈송이",
  "바람개비",
  "종이배",
  "징검다리",
  "주전자",
  "우산꽂이",
  "달팽이집",
  "초록문",
  "파란병",
  "작은등대",
  "빨간우체통",
  "느린시계",
  "둥근돌",
];

/**
 * 라인별 예시 챔피언(키는 src/shared/champions.ts). 목록을 통째로 불러오지 않으려고 키만 적는다(예시 화면 용량).
 * 챔피언 키가 목록에 있는지는 test/champion-tier.test.ts가 확인한다.
 */
const CHAMPION_POOLS: Record<Position, readonly string[]> = {
  top: ["Garen", "Darius", "Fiora", "Camille", "Jax", "Sett", "Malphite", "Ornn", "Riven", "Aatrox", "Gwen", "KSante"],
  jungle: ["LeeSin", "Vi", "Kayn", "Graves", "Hecarim", "Amumu", "Warwick", "Viego", "Khazix", "Nidalee", "JarvanIV", "Ekko"],
  mid: ["Ahri", "Syndra", "Yasuo", "Yone", "Zed", "Orianna", "Viktor", "Akali", "Sylas", "Lux", "Katarina", "Hwei", "Aurora"],
  adc: ["Jinx", "Kaisa", "Ezreal", "Ashe", "Caitlyn", "Jhin", "Vayne", "MissFortune", "Lucian", "Xayah", "Smolder", "Yunara"],
  support: ["Thresh", "Lulu", "Nautilus", "Leona", "Karma", "Nami", "Rakan", "Blitzcrank", "Morgana", "Senna", "Milio", "Braum"],
};

const MEMOS = [
  "마지막 한타로 뒤집은 경기",
  "초반 바론 스틸",
  "처음 온 분 첫 경기",
  "라인 바꿔서 해 본 판",
  "30분 넘게 이어진 경기",
  "용 네 마리 먼저 가져감",
];

/** 시드 고정 난수(mulberry32). */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 24 * 3600_000;
/** 마지막 모임 날(금요일). 지금 시각과 상관없이 고정이다. */
const LAST_DAY = Date.UTC(2026, 9, 30); // 2026-10-30
/** 한국 20시 = UTC 11시. */
const START_HOUR_UTC = 11;

export interface DemoOptions {
  /** 만들 경기 수. 기본은 매주 금요일 2~4경기로 2026년 3~10월을 채운 수(약 100). 측정용으로 크게 줄 수 있다. */
  matches?: number;
  seed?: number;
}

/** 예시 모임 스냅숏(조회 링크 응답과 같은 모양, role "viewer"). */
export function buildDemoSnapshot(options: DemoOptions = {}): Snapshot {
  const random = seeded(options.seed ?? 20261106);
  const people: ParticipantView[] = NAMES.map((name, i) => ({
    id: `demo-p${String(i + 1).padStart(2, "0")}`,
    name,
    status: i >= 22 ? "archived" : "active",
  }));
  // 숨은 실력(승패를 정할 때만 쓰고 저장하지 않는다). 랭킹이 고르게 퍼지게 한다.
  const strength = new Map(people.map((p) => [p.id, random() * 2 - 1]));
  // 앞 16명은 자주, 나머지는 가끔 나온다.
  const regulars = people.slice(0, 16);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const shuffle = <T,>(items: readonly T[]): T[] => {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  };

  // 모임 날짜: 기본(약 100경기)은 매주, 측정용으로 많이 만들 때는 매일 거슬러 올라간다.
  const target = options.matches;
  const sessionDays: number[] = [];
  const perSession: number[] = [];
  let total = 0;
  for (let week = 0; target === undefined ? LAST_DAY - week * 7 * DAY_MS >= Date.UTC(2026, 2, 6) : total < target; week++) {
    const count = 2 + Math.floor(random() * 3);
    const size = target === undefined ? count : Math.min(count, target - total);
    sessionDays.unshift(LAST_DAY - week * (target !== undefined && target > 150 ? 1 : 7) * DAY_MS);
    perSession.unshift(size);
    total += size;
  }

  const matches: MatchView[] = [];
  const series: SeriesView[] = [];
  let matchNo = 0;
  sessionDays.forEach((day, sessionIndex) => {
    const sessionId = `demo-s${sessionIndex + 1}`;
    const games = perSession[sessionIndex]!;
    // 마지막 두 모임 날의 앞 경기들은 같은 사람들로 3판 2선승 시리즈를 한다.
    const isSeriesDay = target === undefined && sessionIndex >= sessionDays.length - 2;
    let seriesRoster: RosterEntry[] | null = null;
    const seriesIds: string[] = [];
    const seriesWins = { A: 0, B: 0 };
    const seriesOpen = () => isSeriesDay && seriesWins.A < 2 && seriesWins.B < 2;
    for (let g = 0; g < games; g++) {
      matchNo += 1;
      const pool = random() < 0.2 ? people : regulars;
      let roster: RosterEntry[];
      if (seriesRoster && seriesOpen()) {
        roster = seriesRoster;
      } else {
        const ten = shuffle(pool).slice(0, 10);
        roster = ten.map((p, i) => ({
          participantId: p.id,
          team: (i < 5 ? "A" : "B") as Team,
          position: POSITIONS[i % 5]!,
        }));
      }
      if (isSeriesDay && !seriesRoster) seriesRoster = roster;
      const power = (team: Team) =>
        roster.filter((r) => r.team === team).reduce((sum, r) => sum + strength.get(r.participantId)!, 0);
      const chanceA = 1 / (1 + Math.exp(-(power("A") - power("B")) * 0.9));
      const winnerTeam: Team = random() < chanceA ? "A" : "B";
      const sideRoll = random();
      const teamASide: Side = sideRoll < 0.45 ? "blue" : sideRoll < 0.9 ? "red" : "unknown";
      const started = day + START_HOUR_UTC * 3600_000 + g * 40 * 60_000;
      const ended = started + (25 + Math.floor(random() * 15)) * 60_000;
      const id = `demo-m${String(matchNo).padStart(4, "0")}`;
      const match: MatchView = {
        id,
        matchNo,
        sessionId,
        state: "confirmed",
        source: "live",
        startedAt: new Date(started).toISOString(),
        endedAt: new Date(ended).toISOString(),
        playedAt: new Date(started).toISOString(),
        confirmedAt: new Date(ended).toISOString(),
        winnerTeam,
        teamASide,
        version: 2,
        roster,
      };
      if (target === undefined && random() < 0.07) match.memo = pick(MEMOS);
      matches.push(match);
      if (isSeriesDay && roster === seriesRoster && seriesOpen()) {
        seriesIds.push(id);
        seriesWins[winnerTeam] += 1;
      }
    }
    if (seriesIds.length >= 2) {
      series.push({
        id: `demo-series${series.length + 1}`,
        name: series.length === 0 ? "예시 시리즈" : "예시 결승",
        format: "bo3",
        createdAt: matches.find((m) => m.id === seriesIds[0])!.endedAt!,
        matchIds: seriesIds,
      });
    }
  });

  addChampions(matches, people, options.seed ?? 20261106);

  const seasons: SeasonView[] = [
    { id: "demo-season1", name: "예시 시즌 1", startsOn: "2026-03-01", endsOn: "2026-06-30" },
    { id: "demo-season2", name: "예시 시즌 2", startsOn: "2026-07-01", endsOn: "2026-10-31" },
  ];

  return {
    role: "viewer",
    serverTime: new Date(LAST_DAY + DAY_MS).toISOString(),
    group: {
      id: "demo",
      name: DEMO_GROUP_NAME,
      timezone: "Asia/Seoul",
      liveVersion: 1,
      settings: { ...DEFAULT_SETTINGS },
      maintenance: false,
    },
    participants: people,
    session: null,
    rotation: null,
    matches,
    revisions: [],
    seasons,
    series,
  };
}

/**
 * 경기 명단에 챔피언을 채운다. 승패·명단을 만든 난수와 따로 굴려서, 챔피언을 바꿔도 다른 예시 기록(순위·시즌 시상)은 그대로다.
 * - 앞 25% 경기는 비운다(챔피언 기록을 중간부터 시작한 모임). 그 뒤 경기도 10%는 통째로, 기록한 경기도 칸마다 5%는 비운다.
 * - 사람마다 라인별 즐겨 쓰는 챔피언 셋이 있고 70%는 그중에서(앞의 것일수록 자주), 나머지는 그 라인 아무 챔피언이나 고른다.
 * - 한 경기 안에서는 같은 챔피언이 겹치지 않게 한다(실제 게임처럼).
 */
function addChampions(matches: MatchView[], people: readonly ParticipantView[], seed: number): void {
  const random = seeded(seed ^ 0x5eed);
  const favorites = new Map<string, string[]>();
  for (const person of people) {
    for (const position of POSITIONS) {
      const pool = [...CHAMPION_POOLS[position]];
      const picks: string[] = [];
      for (let i = 0; i < 3; i++) picks.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
      favorites.set(`${person.id}:${position}`, picks);
    }
  }
  const startAt = Math.floor(matches.length * 0.25);
  matches.forEach((match, index) => {
    if (index < startAt || random() < 0.1) return;
    const used = new Set<string>();
    match.roster = match.roster.map((entry) => {
      if (!entry.position || random() < 0.05) return entry;
      const pool = CHAMPION_POOLS[entry.position];
      const liked = favorites.get(`${entry.participantId}:${entry.position}`)!;
      let key = "";
      for (let tries = 0; tries < 6 && (key === "" || used.has(key)); tries++) {
        const roll = random();
        key = roll < 0.35 ? liked[0]! : roll < 0.55 ? liked[1]! : roll < 0.7 ? liked[2]! : pool[Math.floor(random() * pool.length)]!;
      }
      if (used.has(key)) return entry;
      used.add(key);
      return { ...entry, champion: key };
    });
  });
}
