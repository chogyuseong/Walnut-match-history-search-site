import { useEffect, useMemo, useState } from "react";
import { avoidMapFor } from "../../../shared/avoid";
import { draftFromMatch, type Draft, type DraftPerson } from "../../../shared/draft";
import { poolText, sessionMatchesOf, tonightStats, type NightDraft } from "../../../shared/nightPool";
import { withBench } from "../../../shared/prepTools";
import type { TeamConstraint } from "../../../shared/recommend";
import type { MatchView } from "../../../shared/types";
import { nameMap } from "../../format";
import { liveNightPool, readCarry, writeNightPool } from "../../nightPoolStore";
import type { AppValue } from "../../useApp";

/**
 * 준비 화면의 오늘 명단(쉬는 사람 구역·안내 줄). 명단은 기기 보관값이고 판 수는 스냅숏에서 센다(src/shared/nightPool.ts).
 * 대기자 목록 자체는 지금처럼 초안(draft.bench)에 있다. 맞바꾸기가 빠진 사람을 대기자 끝으로 보내는 동작을 그대로 두려고
 * 명단 순서로 다시 줄 세우지 않는다. 명단에서 빼고 넣는 일만 두 곳을 함께 고친다.
 */
export function useNightPool(app: AppValue, draft: NightDraft, update: (next: Draft) => void) {
  // 빼기·추가로 보관값을 바꾼 뒤 다시 읽게 하는 신호. 스냅숏이 바뀌지 않아도 화면이 새 명단을 그린다.
  const [version, setVersion] = useState(0);
  const [removed, setRemoved] = useState<{ person: DraftPerson; index: number } | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version은 보관값을 다시 읽으라는 신호라 계산에 쓰지 않는다.
  const live = useMemo(() => liveNightPool(app.snapshot), [app.snapshot, version]);
  const pool = live?.pool ?? null;
  const bench = draft.bench ?? [];

  // 서버 상태에 맞춘 명단(새 이름의 참가자 ID, 합치기, 다른 기기에서 교체로 들어온 사람)을 보관하고,
  // 다른 기기에서 들어온 사람이 이 초안 어디에도 없으면 대기자 끝에 붙인다.
  useEffect(() => {
    if (!live?.changed) return;
    writeNightPool(live.pool);
    const known = new Set([...draft.people, ...bench].map((p) => p.key));
    const missing = live.added.filter((p) => !known.has(p.key));
    if (missing.length > 0) update(withBench(draft, [...bench, ...missing]));
    // 저장한 뒤 한 번 다시 읽어 changed를 내린다(같은 추가를 되풀이하지 않게).
    setVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 명단이 서버 상태와 어긋날 때만 한 번 맞춘다.
  }, [live]);

  const stats = useMemo(
    () => (pool && app.snapshot ? tonightStats(pool, sessionMatchesOf(pool, app.snapshot.matches)) : null),
    [pool, app.snapshot],
  );

  /** left는 빼기로 뺀 사람의 키. 다시 넣은 사람은 빼 둔다(syncPool이 다른 기기 경기에서 되살리지 않게 남기는 목록). */
  function save(people: DraftPerson[], left: string[]) {
    const kept = new Set(people.map((p) => p.key));
    writeNightPool({ ...pool!, people, left: left.filter((k) => !kept.has(k)) });
    setVersion((v) => v + 1);
  }

  /** 먼저 간 사람: 오늘 명단과 대기자에서 함께 뺀다. 바로 아래 줄의 되돌리기로 같은 자리에 돌아온다. */
  function drop(key: string) {
    if (!pool) return;
    const index = pool.people.findIndex((p) => p.key === key);
    const person = pool.people[index] ?? bench.find((p) => p.key === key);
    if (!person) return;
    save(
      pool.people.filter((p) => p.key !== key),
      [...(pool.left ?? []), key],
    );
    update(withBench(draft, bench.filter((p) => p.key !== key)));
    setRemoved({ person, index: index < 0 ? pool.people.length : index });
  }

  function undoDrop() {
    if (!pool || !removed) return;
    const people = [...pool.people];
    people.splice(removed.index, 0, removed.person);
    save(people, pool.left ?? []);
    update(withBench(draft, [...bench, removed.person]));
    setRemoved(null);
  }

  /** 늦게 온 사람: 오늘 명단과 쉬는 사람 끝에 넣는다. 다음 판 제안에서 바로 들어온다(쉬던 사람이라서). */
  function addLate(person: DraftPerson) {
    if (!pool) return;
    save([...pool.people.filter((p) => p.key !== person.key), person], pool.left ?? []);
    update(withBench(draft, [...bench.filter((p) => p.key !== person.key), person]));
    setRemoved(null);
  }

  /**
   * "같은 10명으로": 쉬던 사람을 넣기 전, 직전 경기 10명으로 초안을 다시 만든다(이력 되돌리기가 아니다).
   * 쉬는 사람은 명단 순서로 다시 두고, 팀 조건은 지금 것과 이어 온 것 중 두 사람이 모두 있는 것만 남긴다.
   */
  function sameTen(source: MatchView) {
    const snapshot = app.snapshot!;
    const fresh = draftFromMatch(source, nameMap(snapshot), {
      groupId: draft.groupId,
      baseLiveVersion: draft.baseLiveVersion,
      seed: draft.seed,
      now: new Date().toISOString(),
      avoid: avoidMapFor(
        source.roster.map((r) => ({ key: `p:${r.participantId}`, participantId: r.participantId })),
        snapshot.participants,
      ),
    });
    const keys = new Set(fresh.people.map((p) => p.key));
    const constraints: TeamConstraint[] = [];
    for (const c of [...(draft.constraints ?? []), ...readCarry(snapshot.group.id)]) {
      const samePair = (o: TeamConstraint) => (o.a === c.a && o.b === c.b) || (o.a === c.b && o.b === c.a);
      if (keys.has(c.a) && keys.has(c.b) && !constraints.some(samePair)) constraints.push(c);
    }
    const next: NightDraft = {
      ...fresh,
      sourceMatchId: draft.sourceMatchId,
      series: draft.series,
      constraints,
      ...(draft.night ? { night: { ...draft.night, swaps: [], carried: constraints.length } } : {}),
    };
    update(withBench(next, pool?.people ?? [...draft.people, ...bench]));
  }

  return {
    pool,
    stats,
    removed,
    drop,
    undoDrop,
    addLate,
    sameTen,
    text: () => (pool ? poolText(pool) : ""),
  };
}

export type NightPoolEditing = ReturnType<typeof useNightPool>;
