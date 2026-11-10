import type { Draft, DraftPerson } from "../shared/draft";
import {
  carryRecord,
  goneFromSession,
  parseCarry,
  parseNightPool,
  poolIsLive,
  syncPool,
  type NightPool,
} from "../shared/nightPool";
import type { TeamConstraint } from "../shared/recommend";
import type { Snapshot } from "../shared/types";

// 오늘 명단과 이어 갈 팀 조건의 기기 보관(docs/개선-오늘명단-설계-2026-11-10.md ⑥). 계산은 src/shared/nightPool.ts가 한다.
// 키 이름을 바꾸면 useApp.ts forgetGroupStorage의 같은 문자열도 바꾼다(첫 화면 묶음이라 이 파일을 import하지 않는다).

const nightKey = (groupId: string) => `naejeon.night.v1.${groupId}`;
const carryKey = (groupId: string) => `naejeon.constraints.v1.${groupId}`;

export function readNightPool(groupId: string): NightPool | null {
  try {
    return parseNightPool(localStorage.getItem(nightKey(groupId)), groupId);
  } catch {
    return null;
  }
}

export function writeNightPool(pool: NightPool): void {
  try {
    localStorage.setItem(nightKey(pool.groupId), JSON.stringify(pool));
  } catch {
    // 보관하지 못하면 다음 판 제안만 없어진다. 편성과 시작은 그대로 된다.
  }
}

/**
 * 오늘 것으로 볼 수 있는 명단을 서버 상태에 맞춰 돌려준다. 저장은 하지 않는다(부른 쪽이 정한다).
 * changed는 맞추면서 저장값과 달라졌는지(저장할지 판단용).
 */
export function liveNightPool(
  snapshot: Snapshot | null,
  nowMs = Date.now(),
): { pool: NightPool; added: DraftPerson[]; changed: boolean } | null {
  if (!snapshot) return null;
  const stored = readNightPool(snapshot.group.id);
  if (!stored || !poolIsLive(stored, snapshot, nowMs)) return null;
  const synced = syncPool(stored, snapshot);
  return { ...synced, changed: synced.pool !== stored };
}

/**
 * 고르기 화면에서 11명 이상으로 팀을 짰을 때 명단을 새로 쓴다. 이미 오늘 세션에 묶인 명단이면 그 세션을 이어 간다.
 * 그 세션에서 뛰었는데 새 명단에 없는 사람은 집에 간 사람으로 left에 남긴다(goneFromSession).
 */
export function startNightPool(snapshot: Snapshot | null, groupId: string, people: readonly DraftPerson[]): void {
  const now = new Date();
  writeNightPool({
    v: 1,
    groupId,
    sessionId: liveNightPool(snapshot, now.getTime())?.pool.sessionId ?? null,
    createdAt: now.toISOString(),
    people: [...people],
    left: snapshot ? goneFromSession(snapshot, people, now.getTime()) : [],
  });
}

/**
 * 시작에 성공한 뒤 명단을 그 경기의 세션에 묶는다. 시작한 편성에 명단 밖 사람(교체 창으로 넣은 사람)이 있으면 끝에 더하고,
 * 시작하면서 참가자 ID가 생긴 새 이름은 "p:" 키로 바꾼다. 오늘 것이 아닌 명단은 건드리지 않는다(지난주 명단이 되살아나지 않게).
 * 명단을 만들기 전에 이 세션에서 뛰고 간 사람은 startNightPool이 left에 남겨 두어, 묶인 뒤에도 syncPool이 되살리지 않는다.
 */
export function bindNightPool(before: Snapshot, sessionId: string | null, started: Draft): void {
  const live = liveNightPool(before);
  if (!live || sessionId === null) return;
  const idOf = new Map(started.people.map((p) => [p.key, p]));
  const asStarted = (p: DraftPerson): DraftPerson => {
    const s = idOf.get(p.key);
    return s?.participantId ? { key: `p:${s.participantId}`, name: s.name, participantId: s.participantId } : p;
  };
  const people = live.pool.people.map(asStarted);
  for (const p of started.people.map(asStarted)) if (!people.some((q) => q.key === p.key)) people.push(p);
  writeNightPool({ ...live.pool, sessionId, people });
}

/** 시작한 편성의 팀 조건을 다음 판으로 넘기려고 남긴다(⑤). 조건이 없으면 지운다(carryRecord). */
export function saveCarry(groupId: string, started: Draft): void {
  try {
    const record = carryRecord(started, new Date().toISOString());
    if (record) localStorage.setItem(carryKey(groupId), JSON.stringify(record));
    else localStorage.removeItem(carryKey(groupId));
  } catch {
    // 남기지 못하면 다음 판이 조건 없이 시작할 뿐이다.
  }
}

/** 12시간 안에 남긴 조건. */
export function readCarry(groupId: string): TeamConstraint[] {
  try {
    return parseCarry(localStorage.getItem(carryKey(groupId)), Date.now());
  } catch {
    return [];
  }
}
