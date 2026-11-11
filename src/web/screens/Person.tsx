import { useMemo, useState } from "react";
import {
  bestLine,
  COMPARE_MIN_GAMES,
  compareMetrics,
  cumulativeTrend,
  mainLine,
  recentResults,
  resultsOf,
  streakOf,
  streakText,
} from "../../shared/insights";
import {
  matchesInScope,
  personDetail,
  ratePercent,
  scopeLabel as scopeLabelOf,
  SMALL_SAMPLE,
  type PairTally,
  type Scope,
  type Tally,
} from "../../shared/stats";
import { LANE_RIVAL_MIN, laneRivals, laneRivalSummary, pairRecord } from "../../shared/headToHead";
import {
  computeRatings,
  RATING_RECENT_GAMES,
  ratingTrend,
  shownRating,
  signedDelta,
  ratingOptionsOf,
  RATING_TIER_HELP,
} from "../../shared/rating";
import { resolveMerged } from "../../shared/merge";
import { POSITIONS, type Snapshot } from "../../shared/types";
import { formatDate, nameMap, rateText, rateTier, standingsOf } from "../format";
import { attendanceReport } from "../../shared/attendance";
import { personUpsets, UPSET_THRESHOLD } from "../../shared/upset";
import { csvFileName, downloadText, personMatchesCsv } from "../csvExport";
import { MatchCard, useExpectations } from "../matchCard";
import { useSeriesBadges } from "../seriesPanel";
import {
  BackLink,
  FormDots,
  Help,
  Meter,
  PosLabel,
  RateBar,
  RateRing,
  RatingTierBadge,
  RatingTrendLine,
  ScopePicker,
  ScreenHead,
  TitleBadge,
  TrendLine,
  WinLossBar,
  FilterBar,
} from "../screenKit";

function rate(tally: Tally): string {
  return rateText(tally.wins, tally.games);
}

function line(tally: Tally): string {
  if (tally.games === 0) return "기록 없음";
  return `${rate(tally)} · ${tally.wins}승 ${tally.games - tally.wins}패 (${tally.games}경기)`;
}

/** 승률 숫자에 승률 색 단계(rateTier)를 입힌 글자. 기록이 없으면 "기록 없음". */
function RateText(props: { tally: Tally }) {
  const { tally } = props;
  if (tally.games === 0) return <>기록 없음</>;
  return <span className={rateTier(tally.wins, tally.games)}>{rate(tally)}</span>;
}

/** line()과 같은 글이고 승률 숫자만 색 단계를 따른다. */
function RateLine(props: { tally: Tally }) {
  const { tally } = props;
  if (tally.games === 0) return <>기록 없음</>;
  return (
    <>
      <RateText tally={tally} /> · {tally.wins}승 {tally.games - tally.wins}패 ({tally.games}경기)
    </>
  );
}

/** 참여 경기 카드를 처음에 보여주는 수와 "더 보기"로 더 여는 수. */
const FIRST_PAGE = 10;
const PAGE = 20;
/** 같은 팀·상대 팀 목록에서 처음에 보여주는 사람 수. 나머지는 "더 보기"로 편다. */
const PAIR_PREVIEW = 6;

/** 부분/전체를 정수 %로(승률과 같은 반올림, ratePercent). */
function pct(part: number, whole: number): string {
  return `${ratePercent(part, whole)}%`;
}

/**
 * 개인 통계. 순서: 요약(한눈에 보기) → 최근 → 라인별 → 진영별 → 시너지 → 상대 전적 → 다른 플레이어와 비교 → 맞라인 상대 → 참여 경기(맨 아래).
 * 운영자와 조회자가 같은 화면을 본다. 실력 그룹은 보여주지 않는다.
 */
export function Person(props: {
  snapshot: Snapshot;
  participantId: string;
  back: () => void;
  openMatch: (id: string) => void;
  openPerson: (id: string) => void;
  /** 이 사람과 다른 사람을 비교하는 화면으로 간다. other가 있으면 그 사람과 바로 비교한다. */
  openCompare?: (id: string, other?: string) => void;
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
  const seriesBadge = useSeriesBadges(snapshot);
  const expectation = useExpectations(snapshot);
  const person = snapshot.participants.find((p) => p.id === participantId);

  const scoped = useMemo(() => matchesInScope(snapshot, scope), [snapshot, scope]);
  const detail = useMemo(
    () => personDetail(scoped, participantId, nameOf),
    [scoped, participantId, nameOf],
  );
  const results = useMemo(() => resultsOf(scoped, participantId), [scoped, participantId]);
  // 이변 지수(upset.ts): 예상은 누적 MMR로, 세는 경기는 고른 범위.
  const upsets = useMemo(
    () => personUpsets(expectation, scoped, participantId),
    [expectation, scoped, participantId],
  );
  // 참석 통계(attendance.ts): 고른 범위 안의 모임 날 기준.
  const attendance = useMemo(
    () => attendanceReport(scoped, snapshot.group.timezone).people.get(participantId) ?? null,
    [scoped, snapshot, participantId],
  );
  // 처음 몇 경기의 누적 승률은 크게 흔들리므로 SMALL_SAMPLE경기째부터 그린다.
  const trend = useMemo(
    () => cumulativeTrend(results).filter((p) => p.game >= SMALL_SAMPLE),
    [results],
  );
  // 배치와 칭호는 범위와 무관하게 전체 누적 기준이다.
  const standings = useMemo(() => standingsOf(snapshot), [snapshot]);
  // 결과 기반 MMR도 범위와 무관하게 모임 전체 누적 확정 경기로 계산한다(rating.ts).
  const ratingOptions = ratingOptionsOf(snapshot.group.settings);
  const { placementGames } = ratingOptions;
  const rating = useMemo(
    () => computeRatings(snapshot.matches, ratingOptionsOf(snapshot.group.settings)).get(participantId) ?? null,
    [snapshot, participantId],
  );
  const ratingPoints = useMemo(() => (rating ? ratingTrend(rating.history) : []), [rating]);
  // 상대 전적 보기(2026-11-07): 같은 모임의 활성 참가자 중 한 명을 골라 이 사람 기준 상대·같은 팀 전적을 본다.
  const [rival, setRival] = useState<string | null>(null);
  const rivals = useMemo(
    () =>
      snapshot.participants
        .filter((p) => p.status === "active" && !p.mergedInto && p.id !== participantId)
        .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [snapshot, participantId],
  );
  const pair = useMemo(
    () => (rival ? pairRecord(scoped, participantId, rival) : null),
    [scoped, participantId, rival],
  );
  // 배치 중인 상대는 뺀다. 몇 판 안 뛴 사람과의 한두 경기가 "가장 쉬운·어려운 상대"로 뽑히지 않게(랭킹과 같은 누적 기준).
  const laneOpponents = useMemo(
    () => laneRivals(scoped, participantId).filter((r) => standings.get(r.opponentId)?.done),
    [scoped, participantId, standings],
  );
  const lanePicks = useMemo(() => laneRivalSummary(laneOpponents), [laneOpponents]);

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
    grade: null,
  };
  const streaks = streakOf(results);
  const main = mainLine(detail.byPosition);
  const topRate = bestLine(detail.byPosition);
  // 다른 사람과 비교하는 지표는 누적 COMPARE_MIN_GAMES경기 이상인 사람끼리만(범위와 무관한 누적 기준).
  const cmp = compareMetrics(detail, standings);
  const lockedText = `누적 ${COMPARE_MIN_GAMES}경기부터 보여줘요 (지금 ${cmp.games}경기)`;
  const recent10 = recentResults({ results, ...streaks }, 10);

  const orderPairs = (pairs: PairTally[]) =>
    pairOrder === "games"
      ? pairs
      : [...pairs].sort((a, b) => b.wins / b.games - a.wins / a.games || b.games - a.games);

  const pairList = (
    pairs: PairTally[],
    all: PairTally[],
    empty: string,
    which: "synergy" | "versus",
  ) => {
    if (!cmp.ready) return <p className="hint">{lockedText}</p>;
    const rule = <p className="hint">누적 {COMPARE_MIN_GAMES}경기 이상인 사람만 보여줘요.</p>;
    if (pairs.length === 0) {
      return (
        <>
          {rule}
          <p className="hint">
            {all.length === 0 ? empty : `누적 ${COMPARE_MIN_GAMES}경기 이상인 상대가 아직 없어요.`}
          </p>
        </>
      );
    }
    const ordered = orderPairs(pairs);
    const open = pairsOpen[which];
    const listedPairs = open ? ordered : ordered.slice(0, PAIR_PREVIEW);
    const rest = ordered.length - listedPairs.length;
    return (
      <>
        {rule}
        <ul className="list list-card">
          {listedPairs.map((pair) => (
            <li key={pair.participantId}>
              <button
                type="button"
                className="list-row has-bar"
                onClick={() => props.openPerson(pair.participantId)}
              >
                <span className="name">{nameOf(pair.participantId)}</span>
                <span className="stat">
                  <RateLine tally={pair} />
                  {pair.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
                </span>
                <RateBar wins={pair.wins} games={pair.games} small />
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

  const pairTile = (pair: PairTally | null, sub: string, pool: PairTally[]) =>
    !cmp.ready ? (
      <span className="tile-sub">{lockedText}</span>
    ) : pair ? (
      <>
        <button type="button" className="link tile-link" onClick={() => props.openPerson(pair.participantId)}>
          {nameOf(pair.participantId)}
        </button>
        <span className="tile-sub">
          {sub} <RateLine tally={pair} />
        </span>
        <RateBar wins={pair.wins} games={pair.games} small />
      </>
    ) : (
      <span className="tile-sub">
        {pool.length === 0
          ? `누적 ${COMPARE_MIN_GAMES}경기 이상인 상대가 아직 없어요`
          : `${SMALL_SAMPLE}경기 이상 기록이 없어요`}
      </span>
    );

  const lineTile = (picked: ReturnType<typeof mainLine>, none: string) =>
    picked ? (
      <>
        <strong>
          <PosLabel position={picked.position} />
        </strong>
        <span className="tile-sub">
          <RateLine tally={picked.tally} />
          {picked.tally.games < SMALL_SAMPLE ? " · 자료 적음" : ""}
        </span>
        <RateBar wins={picked.tally.wins} games={picked.tally.games} small />
      </>
    ) : (
      <span className="tile-sub">{none}</span>
    );

  const listed = detail.matches.slice(0, shown);
  // 라인 비중: 포지션 기록이 있는 경기 중 그 라인으로 뛴 몫.
  const positioned = POSITIONS.reduce((n, p) => n + (detail.byPosition[p]?.games ?? 0), 0);

  return (
    <div className="screen cols person-screen">
      <ScreenHead
        back={<BackLink label="← 기록" fallback={props.back} />}
        title={person.name}
        badge={person.status === "archived" && <span className="badge">보관</span>}
        desc={`${scopeLabel} 기록 · 배치와 칭호는 누적 기준`}
        actions={
          props.openCompare && (
            <button type="button" className="secondary" onClick={() => props.openCompare!(participantId)}>
              다른 사람과 비교
            </button>
          )
        }
      />

      <FilterBar label="보기 조건">
        <ScopePicker
          snapshot={snapshot}
          scope={scope}
          onChange={(next) => {
            setScope(next);
            setShown(FIRST_PAGE);
          }}
        />
      </FilterBar>

      <section className="card person-summary full" aria-label="요약">
        <h2>요약 ({scopeLabel})</h2>
        <div className="ps-head">
          <div className="ps-hero">
            <RateRing wins={detail.summary.wins} games={detail.summary.games} />
            <div className="ps-main">
              <p className={`summary-line ${rateTier(detail.summary.wins, detail.summary.games)}`}>
                {line(detail.summary)}
              </p>
              <p className="hint">
                {placement.done
                  ? `배치 완료 · 누적 ${placement.games}경기 (누적 기준)`
                  : `배치 진행 중 · ${placement.games}/${placementGames}경기 (누적 기준)`}
              </p>
              {rating && rating.games > 0 && (
                <p className="ps-rating">
                  <span className="rating-num">
                    MMR {shownRating(rating.rating)} · 최고 {shownRating(rating.peak)} · 최근{" "}
                    {Math.min(RATING_RECENT_GAMES, rating.games)}경기 {signedDelta(rating.delta10)}
                  </span>{" "}
                  <RatingTierBadge rating={rating.rating} placed={placement.done} />{" "}
                  <span className="hint">(누적 기준)</span>
                </p>
              )}
              {detail.summary.games > 0 && (
                <p className="ps-streak">
                  {streaks.currentStreak !== 0 && (
                    <strong className={streaks.currentStreak > 0 ? "streak win" : "streak loss"}>
                      {streakText(streaks.currentStreak)}
                    </strong>
                  )}
                  <span className="tile-sub">
                    최다 {streaks.longestWinStreak}연승 · {streaks.longestLoseStreak}연패
                  </span>
                </p>
              )}
              {(upsets.upsetWins > 0 || upsets.underdogGames > 0) && (
                <p className="hint">
                  이변 승 {upsets.upsetWins}회
                  {upsets.underdogGames > 0 &&
                    ` · 약팀일 때 승률 ${pct(upsets.underdogWins, upsets.underdogGames)} (${upsets.underdogGames}경기)`}
                </p>
              )}
              {attendance && (
                <p className="hint">
                  참석 {attendance.days}일 · 출석률 {pct(attendance.days, attendance.eligibleDays)} · 연속{" "}
                  {attendance.currentStreak}일 · 마지막 {formatDate(attendance.lastDate, snapshot.group.timezone)}
                </p>
              )}
              {placement.title && (
                <p className="hint">
                  칭호 <TitleBadge name={placement.title} grade={placement.grade} /> 누적 기준 · 범위를 바꿔도
                  그대로입니다
                </p>
              )}
            </div>
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
              <dt className="tile-label">가장 많이 플레이한 라인</dt>
              <dd>{lineTile(main, "포지션 기록이 없어요")}</dd>
            </div>
            <div>
              <dt className="tile-label">가장 승률 높은 라인</dt>
              <dd>{lineTile(topRate, `라인별 ${SMALL_SAMPLE}경기부터 보여줘요`)}</dd>
            </div>
            <div>
              <dt className="tile-label">잘 맞는 동료</dt>
              <dd>{pairTile(cmp.buddy, "같은 팀일 때", cmp.synergy)}</dd>
            </div>
            <div>
              <dt className="tile-label">어려운 상대</dt>
              <dd>{pairTile(cmp.rival, "상대일 때", cmp.versus)}</dd>
            </div>
          </dl>
        )}
        {/* ─ 추이 두 장: 넓은 화면(768px~)은 승률·MMR을 반씩 한 줄에 나란히, 좁으면 하나씩 쌓인다(.trend-pair) ─ */}
        {(trend.length >= 2 || detail.summary.games > 0 || (rating && rating.games >= 2)) && (
          <div className="trend-pair">
            {trend.length >= 2 ? (
              <TrendLine points={trend} />
            ) : detail.summary.games > 0 ? (
              // 옆(또는 아래) MMR 그래프를 승률 추이로 오해하지 않게 함께 적는다(2026-11-08 화면 점검).
              <p className="hint">
                승률 추이는 {SMALL_SAMPLE + 1}경기부터 그려요{rating && rating.games >= 2 ? "(옆은 MMR 추이)" : ""}.
              </p>
            ) : null}
            {/* MMR 추이는 범위와 무관한 누적 기준이다(승률 추이는 고른 범위). 2경기부터 그린다. */}
            {rating && rating.games >= 2 && <RatingTrendLine points={ratingPoints} start={ratingOptions.start} />}
          </div>
        )}
        {detail.summary.games > 0 && (
          <Help>
            동료·상대는 누적 {COMPARE_MIN_GAMES}경기 이상인 사람 중 {SMALL_SAMPLE}경기 이상 함께하거나 만난
            사람에서 고릅니다. 가장 승률 높은 라인은 {SMALL_SAMPLE}경기 이상 뛴 라인 중에서 고릅니다. 승률은
            모두 {person.name} 기준입니다. 이변 승은 경기 전 예상(누적 MMR)이 {Math.round(UPSET_THRESHOLD * 100)}% 미만이던 팀으로 이긴
            경기이고, 약팀일 때 승률은 예상이 50% 미만이던 경기의 승률입니다. 출석률은 처음 온 날부터 센 모임 날 중 온
            비율입니다. MMR은 시작 {ratingOptions.start}점이고 3연승·3연패부터 변화 폭이 커져요(최대 1.5배). {RATING_TIER_HELP}
          </Help>
        )}
      </section>

      <section aria-label="최근">
        <h2>최근 ({scopeLabel})</h2>
        <ul className="list list-card">
          <li className="list-row static has-bar">
            <span>최근 {detail.recent10.games}경기</span>
            <span className="stat">{line(detail.recent10)}</span>
            <WinLossBar
              wins={detail.recent10.wins}
              losses={detail.recent10.games - detail.recent10.wins}
            />
          </li>
          {detail.recent20.games > 10 && (
            <li className="list-row static has-bar">
              <span>최근 {detail.recent20.games}경기</span>
              <span className="stat">{line(detail.recent20)}</span>
              <WinLossBar
                wins={detail.recent20.wins}
                losses={detail.recent20.games - detail.recent20.wins}
              />
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

      <section className="person-lines" aria-label="라인별">
        <h2>라인별 ({scopeLabel})</h2>
        <ul className="list list-card">
          {POSITIONS.map((position) => {
            const tally = detail.byPosition[position];
            const share = tally && positioned > 0 ? tally.games / positioned : 0;
            return (
              <li key={position} className="list-row static has-bar">
                <PosLabel position={position} />
                <span className="stat">
                  {tally ? <RateLine tally={tally} /> : "기록 없음"}
                  {tally && tally.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
                </span>
                {/* 기록 없는 라인은 빈 막대만 두고 숫자는 적지 않는다("0%"로 읽히지 않게). */}
                <span className="meters">
                  <span className="meter-label">비중</span>
                  <Meter value={share} tone="share" />
                  <span className="meter-value">{tally ? pct(tally.games, positioned) : ""}</span>
                  <span className="meter-label">승률</span>
                  <RateBar wins={tally?.wins ?? 0} games={tally?.games ?? 0} />
                  <span className="meter-value">{tally ? <RateText tally={tally} /> : ""}</span>
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
        <ul className="list list-card">
          <li className="list-row static has-bar">
            <span>블루</span>
            <span className="stat">{line(detail.bySide.blue)}</span>
            <RateBar wins={detail.bySide.blue.wins} games={detail.bySide.blue.games} tone="blue" />
          </li>
          <li className="list-row static has-bar">
            <span>레드</span>
            <span className="stat">{line(detail.bySide.red)}</span>
            <RateBar wins={detail.bySide.red.wins} games={detail.bySide.red.games} tone="red" />
          </li>
        </ul>
        {detail.sideUnknown > 0 && (
          <p className="hint">진영 미상 {detail.sideUnknown}경기는 제외했습니다.</p>
        )}
      </section>

      {/* 순서를 바꿀 목록이 있을 때만(누적 기준 미달이면 목록 대신 안내만 있다). */}
      {cmp.ready && (cmp.synergy.length > 1 || cmp.versus.length > 1) && (
        <div className="segmented" role="group" aria-label="시너지·상대 전적 순서">
          <button type="button" aria-pressed={pairOrder === "games"} onClick={() => setPairOrder("games")}>
            경기 수순
          </button>
          <button type="button" aria-pressed={pairOrder === "rate"} onClick={() => setPairOrder("rate")}>
            승률순
          </button>
        </div>
      )}

      <section aria-label="시너지">
        <h2>같은 팀일 때 ({scopeLabel})</h2>
        {pairList(cmp.synergy, detail.synergy, "같은 팀으로 한 경기가 없어요.", "synergy")}
      </section>

      <section aria-label="상대 전적">
        <h2>상대 팀일 때 ({scopeLabel})</h2>
        {pairList(cmp.versus, detail.versus, "상대 팀으로 만난 경기가 없어요.", "versus")}
        <p className="hint">승률은 {person.name} 기준입니다. 경기 수가 적으면 우연일 수 있습니다.</p>
      </section>

      {/* 영역 이름은 위 "상대 전적"(상대 팀일 때 목록)과 겹치지 않게 따로 둔다. */}
      <section aria-label="다른 플레이어와 비교">
        <h2>다른 플레이어와 비교 ({scopeLabel})</h2>
        <label className="inline-label">
          상대 고르기
          <select value={rival ?? ""} onChange={(e) => setRival(e.target.value || null)}>
            <option value="">고르기</option>
            {rivals.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {rival && pair && (
          // PC에서는 전적 두 줄 옆에 두 사람 비교로 가는 큰 버튼을 나란히 둔다(링크 글자 하나로는 눈에 안 띈다는 요청, 2026-11-08).
          <div className="rival-pane">
            {/* 전적 두 칸은 타일(이름표 위, 값 아래, 막대)로 나란히 두어 빈 공간을 줄인다. list/listitem 구조는 e2e·보조기기용으로 유지. */}
            <ul className="rival-tiles" aria-label={`${nameOf(rival)} 님과의 전적`}>
              <li className="rival-tile">
                <span className="tile-label">상대 팀으로</span>
                <span className="stat">
                  {pair.against.games === 0 ? (
                    "만난 적 없음"
                  ) : (
                    <RateLine tally={{ wins: pair.against.wins, games: pair.against.games }} />
                  )}
                </span>
                <RateBar wins={pair.against.wins} games={pair.against.games} small />
              </li>
              <li className="rival-tile">
                <span className="tile-label">같은 팀으로</span>
                <span className="stat">
                  {pair.together.games === 0 ? (
                    "같은 팀으로 뛴 적 없음"
                  ) : (
                    <RateLine tally={pair.together} />
                  )}
                </span>
                <RateBar wins={pair.together.wins} games={pair.together.games} small />
              </li>
            </ul>
            {props.openCompare && (
              <button
                type="button"
                className="secondary compare-cta"
                onClick={() => props.openCompare!(participantId, rival)}
              >
                <strong>
                  {person.name} vs {nameOf(rival)} 비교 보기
                </strong>
                <span>라인별 승률 · 같은 팀 시너지 · 맞대결 경기를 나란히</span>
              </button>
            )}
          </div>
        )}
        <p className="hint">
          {person.name} 기준입니다. 결과가 확정된 경기만 셉니다(라인 맞대결·두 사람 비교와 같은 기준).
        </p>
      </section>

      <section className="lane-rivals" aria-label="맞라인 상대">
        <h2>맞라인 상대 ({scopeLabel})</h2>
        {laneOpponents.length === 0 ? (
          <p className="hint">배치를 마친 상대와 포지션이 기록된 맞대결이 쌓이면 보여요.</p>
        ) : (
          <>
            <p className="hint">같은 라인에서 상대 팀으로 만난 경기만 세요({person.name} 기준). 배치 중인 상대는 빼요.</p>
            <ul className="list list-card">
              {lanePicks.map(({ position, hardest, easiest }) => (
                <li key={position} className="list-row static lane-rival-row">
                  <PosLabel position={position} />
                  {hardest || easiest ? (
                    <span className="chips">
                      {/* 어려운 쪽은 50% 미만, 쉬운 쪽은 50% 이상에서만 고르므로(laneRivalSummary) 하나만 있을 수 있다. */}
                      {hardest && (
                        <span className="chip lane-chip hard">
                          가장 어려운 {nameOf(hardest.opponentId)} {pct(hardest.wins, hardest.games)} ({hardest.games}경기)
                        </span>
                      )}
                      {easiest && (
                        <span className="chip lane-chip easy">
                          가장 쉬운 {nameOf(easiest.opponentId)} {pct(easiest.wins, easiest.games)} ({easiest.games}경기)
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="hint">{LANE_RIVAL_MIN}경기 이상 맞붙은 상대가 아직 없어요</span>
                  )}
                </li>
              ))}
            </ul>
            <details>
              <summary>전체 보기 ({laneOpponents.length})</summary>
              <ul className="list">
                {laneOpponents.map((r) => (
                  <li key={`${r.position}:${r.opponentId}`}>
                    <button
                      type="button"
                      className="list-row has-bar"
                      onClick={() =>
                        props.openCompare
                          ? props.openCompare(participantId, r.opponentId)
                          : props.openPerson(r.opponentId)
                      }
                    >
                      <span className="name">
                        <PosLabel position={r.position} /> {nameOf(r.opponentId)}
                      </span>
                      <span className="stat">
                        {r.wins}승 {r.losses}패 ({r.games}경기)
                      </span>
                      <RateBar wins={r.wins} games={r.games} small />
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
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
                seriesBadge={seriesBadge(m.id)}
                upset={expectation.get(m.id)?.upset}
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
        {/* 경기 카드 버튼보다 뒤에 둔다(목록의 첫 버튼은 늘 경기 카드). */}
        {detail.matches.length > 0 && (
          <p className="hint csv-row">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                downloadText(
                  csvFileName("내전기록", snapshot, [person.name]),
                  personMatchesCsv(snapshot, participantId, detail.matches),
                )
              }
            >
              CSV 내려받기
            </button>
            <span>
              {scopeLabel} 참여 경기 {detail.matches.length}경기
            </span>
          </p>
        )}
      </section>
    </div>
  );
}
