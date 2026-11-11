import { useMemo, useState, type ReactNode } from "react";
import { laneDuels } from "../../shared/headToHead";
import {
  COMPARE_MIN_GAMES,
  headToHead,
  leadOf,
  mainLine,
  rateLeadOf,
  recentResults,
  resultsOf,
  streakOf,
  streakText,
  synergyPoints,
  type CompareLead,
  type PersonForm,
} from "../../shared/insights";
import {
  matchesInScope,
  personDetail,
  personRecords,
  ratePercent,
  scopeLabel as scopeLabelOf,
  SMALL_SAMPLE,
  type Scope,
  type Tally,
} from "../../shared/stats";
import { resolveMerged } from "../../shared/merge";
import {
  computeRatings,
  ratingBandOf,
  shownRating,
  signedDelta,
  type PersonRating,
  ratingOptionsOf,
} from "../../shared/rating";
import { POSITIONS, type MatchView, type Snapshot } from "../../shared/types";
import { heatClass, nameMap, rateTier, standingsOf } from "../format";
import { MatchCard, useExpectations } from "../matchCard";
import { useSeriesBadges } from "../seriesPanel";
import { BackLink, FormDots, PosLabel, ScopePicker, ScreenHead, StandingNote } from "../screenKit";

function rateText(t: Tally): string {
  return t.games === 0 ? "기록 없음" : `${ratePercent(t.wins, t.games)}%`;
}

function wl(t: Tally): string {
  return t.games === 0 ? "" : `${t.wins}승 ${t.games - t.wins}패`;
}

/** 범위 안 시각 순서 승패와 연승·연패(머리 카드 최근 흐름, 표의 지금·최다 연승). */
function formOf(matches: readonly MatchView[], id: string): PersonForm {
  const results = resultsOf(matches, id);
  return { results, ...streakOf(results) };
}

function tallyOf(results: readonly boolean[]): Tally {
  return { games: results.length, wins: results.filter(Boolean).length };
}

/** 경기 카드를 처음에 보여주는 수와 "더 보기"로 더 여는 수(개인 통계와 같다). */
const FIRST_PAGE = 10;
const PAGE = 20;
/** 머리 카드의 최근 흐름 경기 수와 "상대일 때"의 맞대결 최근 흐름 경기 수. */
const RECENT_GAMES = 10;
const RECENT_DUELS = 5;

/** 앞선 쪽 표시: 굵기(CSS)에 더해 ▲ 기호와 읽기용 글자. 색만으로 구분하지 않는다. */
function LeadMark() {
  return (
    <>
      <span className="cmp-lead-mark" aria-hidden="true">
        ▲
      </span>
      <span className="sr-only">앞섬 </span>
    </>
  );
}

/** 승률 막대(작게). 5경기 미만은 승률 색 없이 속 빈 막대(그래프·개인 통계와 같은 규칙). */
function RateMeter(props: { tally: Tally; className?: string }) {
  const { tally } = props;
  const heat = heatClass(tally.wins, tally.games);
  return (
    <span className={`meter meter-sm ${props.className ?? ""}`} aria-hidden="true">
      <span
        className={`meter-fill ${heat || "tone-muted"}`}
        style={{ width: `${tally.games === 0 ? 0 : (tally.wins / tally.games) * 100}%` }}
      />
      <span className="meter-mid" />
    </span>
  );
}

/**
 * 두 사람 비교(#/compare/A/B). 운영자와 조회 링크가 같은 화면을 쓴다.
 * 머리 카드(요약: 범위 승률·최근 흐름·칭호·MMR·주 라인) → 도구 줄(사람 고르기·서로 바꾸기·범위) →
 * 나란히 보기(자세한 수치, 앞선 쪽 강조) · 라인별 승률 · 같은 라인으로 맞붙었을 때 · 같은 팀일 때(시너지) · 상대일 때(최근 흐름) →
 * 맞대결 경기 목록. 범위 필터를 따르고, 배치·칭호·MMR은 누적 기준이다.
 */
export function Compare(props: {
  snapshot: Snapshot;
  a: string | null;
  b: string | null;
  /** 사람을 바꾼다. null이면 아직 고르지 않음. */
  choose: (a: string | null, b: string | null) => void;
  openMatch: (id: string) => void;
  openPerson: (id: string) => void;
  back: () => void;
}) {
  const { snapshot } = props;
  // 합쳐진 사람의 주소로 들어오면 남은 사람으로 비교한다(기록은 모두 남은 사람에게 있다).
  const a = props.a && props.a !== "-" ? resolveMerged(snapshot.participants, props.a) : null;
  const b = props.b && props.b !== "-" ? resolveMerged(snapshot.participants, props.b) : null;
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [list, setList] = useState<"against" | "together">("against");
  const [shown, setShown] = useState(FIRST_PAGE);
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const seriesBadge = useSeriesBadges(snapshot);
  const expectation = useExpectations(snapshot);
  const scoped = useMemo(() => matchesInScope(snapshot, scope), [snapshot, scope]);
  const standings = useMemo(() => standingsOf(snapshot), [snapshot]);
  // 결과 기반 MMR: 범위와 무관하게 모임 전체 누적(rating.ts).
  const ratingOptions = ratingOptionsOf(snapshot.group.settings);
  const { placementGames } = ratingOptions;
  const ratings = useMemo(() => computeRatings(snapshot.matches, ratingOptionsOf(snapshot.group.settings)), [snapshot]);
  // 고를 수 있는 사람: 확정 경기가 한 번이라도 있는 사람(누적), 이름순.
  const people = useMemo(
    () =>
      [...personRecords(snapshot.matches).keys()].sort((x, y) =>
        nameOf(x).localeCompare(nameOf(y), "ko"),
      ),
    [snapshot, nameOf],
  );
  const known = (id: string | null) =>
    id !== null && snapshot.participants.some((p) => p.id === id && !p.mergedInto);
  const ready = known(a) && known(b) && a !== b;

  const da = useMemo(() => (ready ? personDetail(scoped, a!, nameOf) : null), [ready, scoped, a, nameOf]);
  const db = useMemo(() => (ready ? personDetail(scoped, b!, nameOf) : null), [ready, scoped, b, nameOf]);
  const sa = useMemo(() => (ready ? formOf(scoped, a!) : null), [ready, scoped, a]);
  const sb = useMemo(() => (ready ? formOf(scoped, b!) : null), [ready, scoped, b]);
  const h2h = useMemo(() => (ready ? headToHead(scoped, a!, b!) : null), [ready, scoped, a, b]);
  const duels = useMemo(() => (ready ? laneDuels(scoped, a!, b!) : []), [ready, scoped, a, b]);

  const pickSelect = (slot: "a" | "b", className?: string) => {
    const value = slot === "a" ? a : b;
    const other = slot === "a" ? b : a;
    const label = slot === "a" ? "첫 번째 사람" : "두 번째 사람";
    return (
      <label className={className}>
        {label}
        <select
          aria-label={label}
          value={known(value) ? value! : ""}
          onChange={(e) => {
            const next = e.target.value || null;
            setShown(FIRST_PAGE);
            if (slot === "a") props.choose(next, b);
            else props.choose(a, next);
          }}
        >
          <option value="">고르기</option>
          {people
            .filter((id) => id !== other)
            .map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
        </select>
      </label>
    );
  };

  if (!ready || !da || !db || !sa || !sb || !h2h) {
    // 아직 두 사람을 고르지 않음: 머리 카드 자리에 고르기 두 칸을 둔다.
    return (
      <div className="screen compare-screen">
        <ScreenHead back={<BackLink label="← 기록" fallback={props.back} />} title="두 사람 비교" />
        <div className="cmp-duel is-empty">
          <div className="cmp-card cmp-a cmp-slot">{pickSelect("a", "cmp-slot-pick")}</div>
          <span className="cmp-vs-mark" aria-hidden="true">
            VS
          </span>
          <div className="cmp-card cmp-b cmp-slot">{pickSelect("b", "cmp-slot-pick")}</div>
        </div>
        <p className="hint">
          {people.length < 2
            ? "확정된 경기가 있는 사람이 두 명 이상이어야 비교할 수 있어요."
            : "비교할 두 사람을 골라 주세요. 승률·라인별 승률·같은 팀일 때·상대일 때 전적을 나란히 보여줍니다."}
        </p>
      </div>
    );
  }

  const scopeLabel = scopeLabelOf(snapshot, scope);
  const nameA = nameOf(a!);
  const nameB = nameOf(b!);
  const mainA = mainLine(da.byPosition);
  const mainB = mainLine(db.byPosition);
  const recentA = recentResults(sa, RECENT_GAMES);
  const recentB = recentResults(sb, RECENT_GAMES);
  const matches = list === "against" ? h2h.againstMatches : h2h.togetherMatches;
  // 직접 고른 두 사람이라 막지 않는다. 한쪽이라도 누적 기준 미만이면 표본이 적다고만 알린다.
  const fewer = [a!, b!].filter((id) => (standings.get(id)?.games ?? 0) < COMPARE_MIN_GAMES);

  const ratingA = ratings.get(a!)?.rating ?? ratingOptions.start;
  const ratingB = ratings.get(b!)?.rating ?? ratingOptions.start;
  const synergy = synergyPoints(h2h.together, da.summary, db.summary);
  const against = h2h.against;
  const recentDuels = h2h.againstResults.slice(0, RECENT_DUELS);

  // 기대 승률은 팀 경기라 오해하기 쉬워 보여주지 않는다. 숫자와 차이만.
  const ratingCell = (r: PersonRating | undefined) => (
    <>
      <span className="rating-num">{shownRating(r?.rating ?? ratingOptions.start)}</span>
      <span className="cmp-sub">
        {ratingBandOf(r?.rating ?? ratingOptions.start, ratingOptions.start)} · {r?.games ?? 0}경기
      </span>
    </>
  );

  /** 승률 칸. mark(▲)는 승률 숫자 바로 앞에 둔다(막대와 함께 줄이 바뀌어도 숫자와 떨어지지 않게). */
  const cell = (t: Tally, meter = false) => (mark: ReactNode) => (
    <>
      <span className="cmp-value">
        <span className="cmp-value-num">
          {mark}
          <span className={rateTier(t.wins, t.games)}>{rateText(t)}</span>
        </span>
        {meter && t.games > 0 && <RateMeter tally={t} className="cmp-meter" />}
      </span>
      {t.games > 0 && (
        <span className="cmp-sub">
          {wl(t)} ({t.games}경기)
          {t.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
        </span>
      )}
    </>
  );

  /**
   * 표 한 줄의 두 칸. 앞선 쪽 칸에 ▲와 굵은 글자를 둔다(같으면 강조 없음).
   * 칸 내용이 함수면 ▲를 넘겨 그 안의 알맞은 자리에 두게 하고, 아니면 맨 앞에 둔다.
   */
  type CellContent = ReactNode | ((mark: ReactNode) => ReactNode);
  const pairCells = (lead: CompareLead, left: CellContent, right: CellContent) => {
    const td = (side: "a" | "b", content: CellContent) => {
      const mark = lead === side ? <LeadMark /> : null;
      return (
        <td className={lead === side ? "cmp-lead" : undefined}>
          {typeof content === "function" ? (
            content(mark)
          ) : (
            <>
              {mark}
              {content}
            </>
          )}
        </td>
      );
    };
    return (
      <>
        {td("a", left)}
        {td("b", right)}
      </>
    );
  };

  /**
   * 머리 카드 한 장(요약). 이름은 개인 통계로 가는 버튼이다.
   * 핵심 지표는 셋(범위 승률·최근 흐름·MMR)만 둔다(CLAUDE.md 8절). 칭호·주 라인은 아래 "나란히 보기" 표에 있다.
   */
  const personCard = (side: "a" | "b") => {
    const id = side === "a" ? a! : b!;
    const name = side === "a" ? nameA : nameB;
    const summary = side === "a" ? da.summary : db.summary;
    const recent = side === "a" ? recentA : recentB;
    const rating = ratings.get(id)?.rating ?? ratingOptions.start;
    const recentTally = tallyOf(recent);
    return (
      <article className={`cmp-card cmp-${side}`} aria-label={`${name} 요약`}>
        <button type="button" className="link cmp-name" onClick={() => props.openPerson(id)}>
          {name}
        </button>
        <p className="cmp-card-rate">
          <span className={rateTier(summary.wins, summary.games)}>{rateText(summary)}</span>
          <span className="cmp-card-cap">{scopeLabel} 승률</span>
        </p>
        <p className="cmp-card-wl">
          {summary.games === 0 ? "이 범위 경기 없음" : `${wl(summary)} (${summary.games}경기)`}
          {summary.games > 0 && summary.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
        </p>
        {recent.length > 0 && (
          <div className="cmp-card-form">
            <span className="cmp-card-cap" aria-hidden="true">
              최근 {recent.length}경기
            </span>
            <FormDots
              results={recent}
              label={`최근 ${recent.length}경기 ${recentTally.wins}승 ${recentTally.games - recentTally.wins}패, 최근 것이 앞:`}
            />
          </div>
        )}
        <p className="cmp-card-mmr">
          {/* "MMR 826 · 1100 미만 · 누적": 점수와 구간 숫자가 붙어 읽히지 않게 · 로 나눈다(나란히 보기 표와 같은 꼴). */}
          <span className="cmp-card-cap">MMR</span> <span className="rating-num">{shownRating(rating)}</span>{" "}
          <span className="cmp-card-cap">
            · {ratingBandOf(rating, ratingOptions.start)} · 누적
          </span>
        </p>
      </article>
    );
  };

  return (
    <div className="screen cols viz-root compare-screen">
      <ScreenHead
        back={<BackLink label="← 기록" fallback={props.back} />}
        title={
          <>
            {nameA} <span className="vs">vs</span> {nameB}
          </>
        }
        desc="같은 범위에서 두 사람의 전적을 나란히 봅니다"
      />

      <div className="cmp-duel">
        {personCard("a")}
        <span className="cmp-vs-mark" aria-hidden="true">
          VS
        </span>
        {personCard("b")}
      </div>

      <div className="cmp-tools">
        <div className="cmp-pick compare-pick">
          {pickSelect("a")}
          <button
            type="button"
            className="secondary cmp-swap"
            onClick={() => {
              setShown(FIRST_PAGE);
              props.choose(b, a);
            }}
          >
            <span aria-hidden="true">⇄</span> <span className="cmp-swap-text">서로 바꾸기</span>
          </button>
          {pickSelect("b")}
        </div>
        <ScopePicker
          snapshot={snapshot}
          scope={scope}
          onChange={(next) => {
            setScope(next);
            setShown(FIRST_PAGE);
          }}
        />
      </div>
      {fewer.length > 0 && (
        <p className="hint" role="note">
          표본이 적어요: {fewer.map(nameOf).join(", ")} 님이 누적 {COMPARE_MIN_GAMES}경기 미만이라 비교 결과가
          우연에 크게 흔들릴 수 있어요.
        </p>
      )}

      <section className="cmp-section" aria-label="나란히 보기">
        <h2>나란히 보기 ({scopeLabel})</h2>
        <table className="cmp-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">항목</span>
              </th>
              <th scope="col" className="cmp-col-a">
                {nameA}
              </th>
              <th scope="col" className="cmp-col-b">
                {nameB}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">승률</th>
              {pairCells(rateLeadOf(da.summary, db.summary), cell(da.summary), cell(db.summary))}
            </tr>
            <tr>
              <th scope="row">최근 {RECENT_GAMES}경기</th>
              {pairCells(
                rateLeadOf(tallyOf(recentA), tallyOf(recentB)),
                recentA.length > 0 ? wl(tallyOf(recentA)) : "기록 없음",
                recentB.length > 0 ? wl(tallyOf(recentB)) : "기록 없음",
              )}
            </tr>
            <tr>
              <th scope="row">배치·칭호</th>
              <td className="cmp-small">
                <StandingNote standing={standings.get(a!)} placementGames={placementGames} compact />
              </td>
              <td className="cmp-small">
                <StandingNote standing={standings.get(b!)} placementGames={placementGames} compact />
              </td>
            </tr>
            <tr>
              <th scope="row">MMR (누적)</th>
              {pairCells(
                leadOf(shownRating(ratingA), shownRating(ratingB)),
                ratingCell(ratings.get(a!)),
                ratingCell(ratings.get(b!)),
              )}
            </tr>
            <tr>
              <th scope="row">MMR 차</th>
              <td colSpan={2}>
                <strong className="cmp-delta">{signedDelta(shownRating(ratingA) - shownRating(ratingB))}</strong>{" "}
                <span className="cmp-sub-inline">{nameA} 기준</span>
              </td>
            </tr>
            <tr>
              <th scope="row">지금</th>
              {pairCells(
                sa.results.length > 0 && sb.results.length > 0 ? leadOf(sa.currentStreak, sb.currentStreak) : null,
                streakText(sa.currentStreak) || "기록 없음",
                streakText(sb.currentStreak) || "기록 없음",
              )}
            </tr>
            <tr>
              <th scope="row">최다 연승</th>
              {pairCells(
                leadOf(sa.longestWinStreak, sb.longestWinStreak),
                `${sa.longestWinStreak}연승`,
                `${sb.longestWinStreak}연승`,
              )}
            </tr>
            <tr>
              <th scope="row">가장 많이 플레이한 라인</th>
              <td>{mainA ? <PosLabel position={mainA.position} /> : "기록 없음"}</td>
              <td>{mainB ? <PosLabel position={mainB.position} /> : "기록 없음"}</td>
            </tr>
          </tbody>
        </table>
        <p className="hint">▲는 그 줄에서 앞선 쪽이에요. 칭호·MMR은 범위와 관계없이 누적 기준입니다.</p>
      </section>

      <section className="cmp-section" aria-label="라인별 승률 비교">
        <h2>라인별 승률 ({scopeLabel})</h2>
        <table className="cmp-table cmp-lines">
          <thead>
            <tr>
              <th scope="col">라인</th>
              <th scope="col" className="cmp-col-a">
                {nameA}
              </th>
              <th scope="col" className="cmp-col-b">
                {nameB}
              </th>
            </tr>
          </thead>
          <tbody>
            {POSITIONS.map((p) => {
              const ta = da.byPosition[p] ?? { games: 0, wins: 0 };
              const tb = db.byPosition[p] ?? { games: 0, wins: 0 };
              return (
                <tr key={p} className={ta.games === 0 && tb.games === 0 ? "cmp-empty-row" : undefined}>
                  <th scope="row">
                    <PosLabel position={p} />
                  </th>
                  {pairCells(rateLeadOf(ta, tb), cell(ta, true), cell(tb, true))}
                </tr>
              );
            })}
          </tbody>
        </table>
        {(da.positionUnknown > 0 || db.positionUnknown > 0) && (
          <p className="hint">
            포지션 기록이 없는 경기는 뺐습니다({nameA} {da.positionUnknown}경기, {nameB}{" "}
            {db.positionUnknown}경기).
          </p>
        )}
      </section>

      {/* 같은 라인으로 서로 마주 선 경기만. 두 사람의 경기 수가 같고 승률은 서로 거울이라(A 60% ↔ B 40%) 한 줄에 둘 다 쓴다.
          각자의 라인별 승률(위 표)은 전체 경기 기준이라 이와 다르다는 피드백이 있어 따로 뗐다. */}
      <section className="cmp-section" aria-label="같은 라인 맞대결">
        <h2>같은 라인으로 맞붙었을 때 ({scopeLabel})</h2>
        {duels.length === 0 ? (
          <p className="hint">두 사람이 같은 라인에서 상대 팀으로 만난 경기가 없어요.</p>
        ) : (
          <>
            <p className="hint">
              왼쪽 {nameA} · 오른쪽 {nameB}. 둘이 같은 포지션으로 상대 팀에 선 경기만 세요. 경기 수는 양쪽이 같고 승률은 서로
              거울이에요.
            </p>
            <ul className="cmp-lane-duels">
              {duels.map((d) => {
                const lead = leadOf(d.wins, d.losses);
                return (
                  <li key={d.position} className={lead === "a" ? "lead-a" : lead === "b" ? "lead-b" : undefined}>
                    <span className="cmp-duel-side cmp-duel-a">
                      <span className={rateTier(d.wins, d.games)}>{rateText({ wins: d.wins, games: d.games })}</span>
                      <span className="hint">{d.wins}승 {d.losses}패</span>
                    </span>
                    <span className="cmp-duel-mid">
                      <PosLabel position={d.position} />
                      <span className="hint">{d.games}경기</span>
                    </span>
                    <span className="cmp-duel-side cmp-duel-b">
                      <span className={rateTier(d.losses, d.games)}>{rateText({ wins: d.losses, games: d.games })}</span>
                      <span className="hint">{d.losses}승 {d.wins}패</span>
                    </span>
                    <span className="cmp-bar cmp-duel-bar" role="img" aria-label={`${d.games}경기 중 ${nameA} ${d.wins}승, ${nameB} ${d.losses}승`}>
                      <span className="cmp-bar-a" style={{ flexGrow: d.wins }} />
                      <span className="cmp-bar-b" style={{ flexGrow: d.losses }} />
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      <section className="cmp-section" aria-label="같은 팀일 때">
        <h2>같은 팀일 때 ({scopeLabel})</h2>
        {h2h.together.games === 0 ? (
          <p className="hint">같은 팀으로 뛴 경기가 없어요.</p>
        ) : (
          <>
            <div className="cmp-face">
              <span className="cmp-face-name cmp-a">{nameA}</span>
              <p className="cmp-face-mid">
                <span className={`${rateTier(h2h.together.wins, h2h.together.games)} cmp-face-big`}>
                  {rateText(h2h.together)}
                </span>{" "}
                <span className="cmp-face-sub">
                  · {wl(h2h.together)} ({h2h.together.games}경기)
                </span>
                {h2h.together.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
              </p>
              <span className="cmp-face-name cmp-b">{nameB}</span>
            </div>
            <span
              className="cmp-together-bar"
              role="img"
              aria-label={`함께 뛴 ${h2h.together.games}경기 중 ${h2h.together.wins}승`}
            >
              <RateMeter tally={h2h.together} />
            </span>
            {synergy !== null && (
              <p className="cmp-synergy">
                {synergy === 0 ? (
                  <>함께 뛰어도 두 사람 평균 승률과 같아요</>
                ) : (
                  <>
                    함께 뛰면 두 사람 평균보다{" "}
                    <strong className={synergy > 0 ? "cmp-up" : "cmp-down"}>
                      {synergy > 0 ? `+${synergy}` : `−${-synergy}`}%p
                    </strong>
                  </>
                )}
                <span className="cmp-sub">
                  {nameA} {rateText(da.summary)} · {nameB} {rateText(db.summary)}의 평균과 견줌
                </span>
              </p>
            )}
          </>
        )}
      </section>

      <section className="cmp-section" aria-label="상대일 때">
        <h2>상대일 때 ({scopeLabel})</h2>
        {against.games === 0 ? (
          <p className="hint">상대 팀으로 만난 경기가 없어요.</p>
        ) : (
          <>
            <p className="cmp-face cmp-score">
              <span className="cmp-face-name cmp-a">{nameA}</span>{" "}
              <strong className={against.aWins > against.bWins ? "cmp-score-n is-lead" : "cmp-score-n"}>
                {against.aWins}승
              </strong>{" "}
              <span className="cmp-score-colon">:</span>{" "}
              <strong className={against.bWins > against.aWins ? "cmp-score-n is-lead" : "cmp-score-n"}>
                {against.bWins}승
              </strong>{" "}
              <span className="cmp-face-name cmp-b">{nameB}</span>
              {against.games < SMALL_SAMPLE && <span className="tag">자료 적음</span>}
            </p>
            <div
              className="cmp-bar"
              role="img"
              aria-label={`${against.games}경기 중 ${nameA} ${against.aWins}승, ${nameB} ${against.bWins}승`}
            >
              <span className="cmp-bar-a" style={{ flexGrow: against.aWins }} />
              <span className="cmp-bar-b" style={{ flexGrow: against.bWins }} />
            </div>
            {/* 다른 화면과 같은 꼴 "승률 · N승 M패 (G경기)"(첫 번째 사람 기준). 승 수만으로는 승률이 한눈에 안 들어온다는 요청(2026-11-08). */}
            <p className="cmp-h2h-rate">
              {nameA} 기준{" "}
              <span className={rateTier(against.aWins, against.games)}>
                {rateText({ wins: against.aWins, games: against.games })}
              </span>{" "}
              · {wl({ wins: against.aWins, games: against.games })} ({against.games}경기)
            </p>
            <div className="cmp-h2h-more">
              <div>
                <p className="row-label">최근 맞대결</p>
                <FormDots
                  results={recentDuels}
                  label={`최근 맞대결 ${recentDuels.length}경기 ${nameA} 기준, 최근 것이 앞:`}
                />
              </div>
            </div>
            <p className="hint">경기 수가 적으면 우연일 수 있습니다.</p>
          </>
        )}
      </section>

      <section className="full cmp-games" aria-label="맞대결 경기">
        <h2>함께 뛴 경기</h2>
        <div className="segmented" role="group" aria-label="경기 목록 고르기">
          <button
            type="button"
            aria-pressed={list === "against"}
            onClick={() => {
              setList("against");
              setShown(FIRST_PAGE);
            }}
          >
            맞대결 {h2h.against.games}
          </button>
          <button
            type="button"
            aria-pressed={list === "together"}
            onClick={() => {
              setList("together");
              setShown(FIRST_PAGE);
            }}
          >
            같은 팀 {h2h.together.games}
          </button>
        </div>
        {matches.length === 0 ? (
          <p className="hint">이 범위에는 해당하는 경기가 없어요.</p>
        ) : (
          <ul className="list match-cards">
            {matches.slice(0, shown).map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                nameOf={nameOf}
                timeZone={snapshot.group.timezone}
                showDate
                focusId={a}
                highlightIds={[a!, b!]}
                onOpen={() => props.openMatch(m.id)}
                seriesBadge={seriesBadge(m.id)}
                upset={expectation.get(m.id)?.upset}
                onPerson={props.openPerson}
              />
            ))}
          </ul>
        )}
        {matches.length > shown && (
          <button type="button" className="link" onClick={() => setShown(shown + PAGE)}>
            나머지 {matches.length - shown}경기 중 {Math.min(PAGE, matches.length - shown)}경기 더 보기
          </button>
        )}
        <p className="hint">카드 색과 승·패 표시는 {nameA} 기준입니다.</p>
      </section>
    </div>
  );
}
