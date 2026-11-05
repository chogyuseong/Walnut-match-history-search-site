import { useMemo, useState } from "react";
import {
  cumulativeTrend,
  mainLine,
  pickPair,
  recentResults,
  resultsOf,
  streakOf,
  streakText,
} from "../../shared/insights";
import {
  matchesInScope,
  personDetail,
  PLACEMENT_GAMES,
  scopeLabel as scopeLabelOf,
  SMALL_SAMPLE,
  type PairTally,
  type Scope,
  type Tally,
} from "../../shared/stats";
import { resolveMerged } from "../../shared/merge";
import { POSITIONS, type Snapshot } from "../../shared/types";
import { nameMap, rateTier, standingsOf } from "../format";
import { MatchCard } from "../matchCard";
import { BackLink, FormDots, PosLabel, ScopePicker, TrendLine } from "../ui";

function rate(tally: Tally): string {
  return tally.games === 0 ? "기록 없음" : `${Math.round((tally.wins / tally.games) * 100)}%`;
}

function line(tally: Tally): string {
  if (tally.games === 0) return "기록 없음";
  return `${rate(tally)} · ${tally.wins}승 ${tally.games - tally.wins}패 (${tally.games}경기)`;
}

/** 참여 경기 카드를 처음에 보여주는 수와 "더 보기"로 더 여는 수. */
const FIRST_PAGE = 10;
const PAGE = 20;
/** 같은 팀·상대 팀 목록에서 처음에 보여주는 사람 수. 나머지는 "더 보기"로 편다. */
const PAIR_PREVIEW = 6;

/**
 * 개인 통계. 순서: 요약(한눈에 보기) → 최근 → 라인별 → 진영별 → 시너지 → 상대 전적 → 참여 경기(맨 아래).
 * 운영자와 조회자가 같은 화면을 본다. 실력 그룹은 보여주지 않는다.
 */
export function Person(props: {
  snapshot: Snapshot;
  participantId: string;
  back: () => void;
  openMatch: (id: string) => void;
  openPerson: (id: string) => void;
  /** 이 사람과 다른 사람을 비교하는 화면으로 간다. */
  openCompare?: (id: string) => void;
}) {
  const { snapshot, participantId } = props;
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [pairOrder, setPairOrder] = useState<"games" | "rate">("games");
  const [shown, setShown] = useState(FIRST_PAGE);
  const [pairsOpen, setPairsOpen] = useState<{ synergy: boolean; versus: boolean }>({
    synergy: false,
    versus: false,
  });
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const person = snapshot.participants.find((p) => p.id === participantId);

  const scoped = useMemo(() => matchesInScope(snapshot, scope), [snapshot, scope]);
  const detail = useMemo(
    () => personDetail(scoped, participantId, nameOf),
    [scoped, participantId, nameOf],
  );
  const results = useMemo(() => resultsOf(scoped, participantId), [scoped, participantId]);
  // 처음 몇 경기의 누적 승률은 크게 흔들리므로 SMALL_SAMPLE경기째부터 그린다.
  const trend = useMemo(
    () => cumulativeTrend(results).filter((p) => p.game >= SMALL_SAMPLE),
    [results],
  );
  // 배치와 칭호는 범위와 무관하게 전체 누적 기준이다.
  const standings = useMemo(() => standingsOf(snapshot), [snapshot]);

  // 중복 참가자 합치기로 다른 사람에게 합쳐진 이름: 기록은 모두 남은 사람에게 옮겨졌으므로 그쪽으로 안내한다.
  const mergedTarget = person?.mergedInto
    ? snapshot.participants.find((p) => p.id === resolveMerged(snapshot.participants, person.id))
    : undefined;
  if (person && mergedTarget) {
    return (
      <div className="screen">
        <header className="screen-head">
          <BackLink label="← 기록" fallback={props.back} />
          <h1>{person.name}</h1>
        </header>
        <p className="note" role="status">
          {person.name} 님은 {mergedTarget.name} 님에게 합쳐졌어요. 경기 기록은 모두 {mergedTarget.name}{" "}
          님 쪽에 있습니다.
        </p>
        <button type="button" className="primary" onClick={() => props.openPerson(mergedTarget.id)}>
          {mergedTarget.name} 님 기록 보기
        </button>
      </div>
    );
  }

  if (!person) {
    return (
      <div className="screen">
        <BackLink label="← 기록" fallback={props.back} />
        <p>참가자를 찾을 수 없어요.</p>
      </div>
    );
  }

  const scopeLabel = scopeLabelOf(snapshot, scope);
  const placement = standings.get(participantId) ?? {
    games: 0,
    done: false,
    title: null,
  };
  const streaks = streakOf(results);
  const main = mainLine(detail.byPosition);
  const buddy = pickPair(detail.synergy, "best");
  const rival = pickPair(detail.versus, "worst");
  const recent10 = recentResults({ results, ...streaks }, 10);

  const orderPairs = (pairs: PairTally[]) =>
    pairOrder === "games"
      ? pairs
      : [...pairs].sort((a, b) => b.wins / b.games - a.wins / a.games || b.games - a.games);

  const pairList = (pairs: PairTally[], empty: string, which: "synergy" | "versus") => {
    if (pairs.length === 0) return <p className="hint">{empty}</p>;
    const ordered = orderPairs(pairs);
    const open = pairsOpen[which];
    const listedPairs = open ? ordered : ordered.slice(0, PAIR_PREVIEW);
    const rest = ordered.length - listedPairs.length;
    return (
      <>
        <ul className="list">
          {listedPairs.map((pair) => (
            <li key={pair.participantId}>
              <button
                type="button"
                className="list-row"
                onClick={() => props.openPerson(pair.participantId)}
              >
                <span className="name">{nameOf(pair.participantId)}</span>
                <span className="stat">
                  {line(pair)}
                  {pair.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {rest > 0 && (
          <button
            type="button"
            className="link more"
            onClick={() => setPairsOpen({ ...pairsOpen, [which]: true })}
          >
            나머지 {rest}명 더 보기
          </button>
        )}
        {open && ordered.length > PAIR_PREVIEW && (
          <button
            type="button"
            className="link more"
            onClick={() => setPairsOpen({ ...pairsOpen, [which]: false })}
          >
            {PAIR_PREVIEW}명만 보기
          </button>
        )}
      </>
    );
  };

  const streak =
    detail.currentStreak > 0
      ? `${detail.currentStreak}연승 중`
      : detail.currentStreak < 0
        ? `${-detail.currentStreak}연패 중`
        : "기록 없음";

  const pairTile = (pair: PairTally | null, sub: string) =>
    pair ? (
      <>
        <button type="button" className="link tile-link" onClick={() => props.openPerson(pair.participantId)}>
          {nameOf(pair.participantId)}
        </button>
        <span className="tile-sub">
          {sub} {rate(pair)} · {pair.games}경기
        </span>
      </>
    ) : (
      <span className="tile-sub">{SMALL_SAMPLE}경기 이상 기록이 없어요</span>
    );

  const listed = detail.matches.slice(0, shown);

  return (
    <div className="screen cols">
      <header className="screen-head">
        <BackLink label="← 기록" fallback={props.back} />
        <h1>{person.name}</h1>
        {person.status === "archived" && <span className="badge">보관</span>}
        {props.openCompare && (
          <button type="button" className="secondary" onClick={() => props.openCompare!(participantId)}>
            다른 사람과 비교
          </button>
        )}
      </header>

      <ScopePicker
        snapshot={snapshot}
        scope={scope}
        onChange={(next) => {
          setScope(next);
          setShown(FIRST_PAGE);
        }}
      />

      <section className="card person-summary full" aria-label="요약">
        <h2>요약 ({scopeLabel})</h2>
        <div className="ps-head">
          <div className="ps-main">
            <p className={`summary-line ${rateTier(detail.summary.wins, detail.summary.games)}`}>
              {line(detail.summary)}
            </p>
            <p className="hint">
              {placement.done
                ? `배치 완료 · 누적 ${placement.games}경기 (누적 기준)`
                : `배치 진행 중 · ${placement.games}/${PLACEMENT_GAMES}경기 (누적 기준)`}
            </p>
            {placement.title && (
              <p className="hint">
                칭호 <span className="title-chip">{placement.title}</span> 누적 기준 · 범위를 바꿔도
                그대로입니다
              </p>
            )}
          </div>
          {recent10.length > 0 && (
            <div className="ps-form">
              <span className="tile-label">최근 {recent10.length}경기 (왼쪽이 최근)</span>
              <FormDots results={recent10} />
            </div>
          )}
        </div>
        {detail.summary.games > 0 && (
          <dl className="ps-tiles">
            <div>
              <dt className="tile-label">지금</dt>
              <dd>
                <strong className={streaks.currentStreak > 0 ? "streak win" : "streak loss"}>
                  {streakText(streaks.currentStreak)}
                </strong>
                <span className="tile-sub">
                  최다 {streaks.longestWinStreak}연승 · {streaks.longestLoseStreak}연패
                </span>
              </dd>
            </div>
            <div>
              <dt className="tile-label">주 라인</dt>
              <dd>
                {main ? (
                  <>
                    <strong>
                      <PosLabel position={main.position} />
                    </strong>
                    <span className="tile-sub">
                      {rate(main.tally)} · {main.tally.games}경기
                      {main.tally.games < SMALL_SAMPLE ? " · 자료 적음" : ""}
                    </span>
                  </>
                ) : (
                  <span className="tile-sub">포지션 기록이 없어요</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="tile-label">잘 맞는 동료</dt>
              <dd>{pairTile(buddy, "같은 팀일 때")}</dd>
            </div>
            <div>
              <dt className="tile-label">어려운 상대</dt>
              <dd>{pairTile(rival, "상대일 때")}</dd>
            </div>
          </dl>
        )}
        {trend.length >= 2 ? (
          <TrendLine points={trend} />
        ) : detail.summary.games > 0 ? (
          <p className="hint">승률 추이는 {SMALL_SAMPLE + 1}경기부터 보여줍니다.</p>
        ) : null}
        {detail.summary.games > 0 && (
          <p className="hint">
            동료·상대는 {SMALL_SAMPLE}경기 이상 함께하거나 만난 사람 중에서 고릅니다. 승률은 모두{" "}
            {person.name} 기준입니다.
          </p>
        )}
      </section>

      <section aria-label="최근">
        <h2>최근 ({scopeLabel})</h2>
        <ul className="list">
          <li className="list-row static">
            <span>최근 {detail.recent10.games}경기</span>
            <span className="stat">{line(detail.recent10)}</span>
          </li>
          {detail.recent20.games > 10 && (
            <li className="list-row static">
              <span>최근 {detail.recent20.games}경기</span>
              <span className="stat">{line(detail.recent20)}</span>
            </li>
          )}
          <li className="list-row static">
            <span>연속</span>
            <span className="stat">
              {streak} · 최다 {detail.longestWinStreak}연승 / {detail.longestLoseStreak}연패
            </span>
          </li>
        </ul>
      </section>

      <section aria-label="라인별">
        <h2>라인별 ({scopeLabel})</h2>
        <ul className="list">
          {POSITIONS.map((position) => {
            const tally = detail.byPosition[position];
            return (
              <li key={position} className="list-row static">
                <PosLabel position={position} />
                <span className="stat">
                  {tally ? line(tally) : "기록 없음"}
                  {tally && tally.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
                </span>
              </li>
            );
          })}
        </ul>
        {detail.positionUnknown > 0 && (
          <p className="hint">포지션 기록이 없는 {detail.positionUnknown}경기는 제외했습니다.</p>
        )}
      </section>

      <section aria-label="진영별">
        <h2>진영별 ({scopeLabel})</h2>
        <ul className="list">
          <li className="list-row static">
            <span>블루</span>
            <span className="stat">{line(detail.bySide.blue)}</span>
          </li>
          <li className="list-row static">
            <span>레드</span>
            <span className="stat">{line(detail.bySide.red)}</span>
          </li>
        </ul>
        {detail.sideUnknown > 0 && (
          <p className="hint">진영 미상 {detail.sideUnknown}경기는 제외했습니다.</p>
        )}
      </section>

      <div className="segmented" role="group" aria-label="시너지·상대 전적 순서">
        <button type="button" aria-pressed={pairOrder === "games"} onClick={() => setPairOrder("games")}>
          경기 수순
        </button>
        <button type="button" aria-pressed={pairOrder === "rate"} onClick={() => setPairOrder("rate")}>
          승률순
        </button>
      </div>

      <section aria-label="시너지">
        <h2>같은 팀일 때 ({scopeLabel})</h2>
        {pairList(detail.synergy, "같은 팀으로 한 경기가 없어요.", "synergy")}
      </section>

      <section aria-label="상대 전적">
        <h2>상대 팀일 때 ({scopeLabel})</h2>
        {pairList(detail.versus, "상대 팀으로 만난 경기가 없어요.", "versus")}
        <p className="hint">승률은 {person.name} 기준입니다. 경기 수가 적으면 우연일 수 있습니다.</p>
      </section>

      <section className="full" aria-label="참여 경기">
        <h2>
          참여 경기 ({scopeLabel}) · {detail.matches.length}경기
        </h2>
        {detail.matches.length === 0 ? (
          <p className="hint">이 범위에는 확정된 경기가 없어요.</p>
        ) : (
          <ul className="list match-cards">
            {listed.map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                nameOf={nameOf}
                timeZone={snapshot.group.timezone}
                showDate
                focusId={participantId}
                onOpen={() => props.openMatch(m.id)}
                onPerson={props.openPerson}
              />
            ))}
          </ul>
        )}
        {detail.matches.length > listed.length && (
          <button type="button" className="link more" onClick={() => setShown(shown + PAGE)}>
            나머지 {detail.matches.length - listed.length}경기 중{" "}
            {Math.min(PAGE, detail.matches.length - listed.length)}경기 더 보기
          </button>
        )}
      </section>
    </div>
  );
}
