// 화면 6 기록(목록·플레이어 랭킹·변경 내역). 보기 조건과 거르기 칸은 recordsView.tsx, 경기 상세는 MatchDetail.tsx에 있다.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  anchorRecord,
  EMPTY_FILTER,
  filterMatches,
  isFilterActive,
  lineRanking,
  matchesWithoutPositions,
  newestFirst,
  personForms,
  rankAndSearch,
  RANKING_GROUP_LABEL,
  RANKING_SORT_LABEL,
  RANKING_VETERAN_GAMES,
  rankingGroup,
  recentResults,
  streakText,
  type MatchFilter,
  type RankingSort,
} from "../../shared/insights";
import { computeRatings, ratingValues, shownRating, ratingOptionsOf, RATING_TIER_HELP } from "../../shared/rating";
import { matchesInScope, scopeLabel as scopeLabelOf, type Scope } from "../../shared/stats";
import { POSITIONS, type MatchView, type Position, type RevisionView, type Snapshot } from "../../shared/types";
import { ApiFailure, mutate, newRequestId } from "../api";
import {
  formatDate,
  formatRange,
  formatTime,
  nameMap,
  POSITION_LABEL,
  objectParticle,
  rankClass,
  rateText,
  rateHueText,
  resultLine,
  standingsOf,
} from "../format";
import { csvFileName, downloadText, matchesCsv, rankingCsv } from "../csvExport";
import { MatchCard, useExpectations } from "../matchCard";
import { SeriesListSection, useSeriesBadges } from "../seriesPanel";
import { FilterBar, Glue, Help, KpiStrip, ScreenHead, SortHead } from "../screenKit";
import { FormDots } from "../rateMeters";
import { RatingTierBadge, StandingNote } from "../rankBadges";
import { replaceRouteParams, ScopeBasis, ScopePicker, scopeSuffix } from "../routeScope";
import { useScrollMemory } from "../scrollMemory";
import { CopyButton, ErrorNote, useSearchJump } from "../ui";
import type { AppValue } from "../useApp";
import { changeText, DELETED_BY_LABEL, deletionOf, REVISION_LABEL } from "./revisionText";
import {
  filterText,
  MatchFilterPeople,
  MatchFilterSelects,
  PAGE,
  readRecordsView,
  recordsParams,
  shareLinkOf,
} from "./recordsView";

/** 플레이어 랭킹 머리 줄의 정렬 열 이름. 정렬 이름(RANKING_SORT_LABEL, 도움말에 쓴다)과 달리 열 머리라 "MMR"만 쓴다. */
const RANK_COLUMN_LABEL: Record<RankingSort, string> = { rate: "승률", wins: "승수", games: "경기 수", rating: "MMR" };

/**
 * 화면 6 — 기록. 운영자와 조회자가 같은 화면을 본다.
 * 틀(2026-11-10 구조 정리): 화면 머리(운영자는 오른쪽에 "지난 경기 입력") → 필터 줄 하나(범위·사람·이긴 진영) → 누적 띠 →
 * PC 2단(왼쪽 좁은 단 경기 카드 목록, 오른쪽 넓은 단 플레이어 랭킹 표). 플레이어 랭킹은 열 머리를 눌러 정렬한다.
 */
export function Records(props: {
  snapshot: Snapshot;
  openMatch: (id: string) => void;
  /** id 뒤에 주소 꼬리("?scope=…")를 붙여 넘길 수 있다. 부르는 쪽은 그대로 경로에 붙인다(App.tsx·Viewer.tsx). */
  openPerson: (id: string) => void;
  openGraphs: () => void;
  openRanking: () => void;
  onResult?: (match: MatchView) => void;
  /** 운영자에게만 있다: 지난 경기 한 건 입력 화면으로 간다. */
  openBackfill?: () => void;
  /** 시즌·연도 범위에서 시즌 요약과 시상 화면으로 간다. */
  openSeason?: (scope: Scope) => void;
  /** 운영자에게만 있다: 시리즈 만들기에 쓴다. */
  app?: AppValue | null;
}) {
  const { snapshot } = props;
  const seriesBadge = useSeriesBadges(snapshot);
  const expectation = useExpectations(snapshot);
  // 처음 보기 조건은 주소에서 읽는다(뒤로 왔을 때·공유 링크). 한 번만 읽고 그 뒤로는 화면 상태를 주소에 적는다.
  // 흐름: 화면 상태(scope·filter·sort·line·shown) → viewParams → 아래 효과가 replaceRouteParams로 주소를 고친다.
  // 주소를 고쳐도 화면 상태를 다시 읽지 않으므로 둘이 서로를 바꾸며 도는 일은 없다.
  const [initial] = useState(() => readRecordsView(snapshot));
  const [scope, setScope] = useState<Scope>(initial.scope);
  const [shown, setShown] = useState(initial.shown);
  const [query, setQuery] = useState("");
  const rankJump = useSearchJump<HTMLDivElement>();
  const [filter, setFilterState] = useState<MatchFilter>(initial.filter);
  const [sort, setSort] = useState<RankingSort>(initial.sort);
  const [line, setLine] = useState<Position | null>(initial.line);
  const viewParams = useMemo(
    () => recordsParams({ scope, filter, sort, line, shown }),
    [scope, filter, sort, line, shown],
  );
  useEffect(() => {
    replaceRouteParams(viewParams);
    // 기록 화면에서 메뉴의 "기록"을 다시 누르면 조건 없는 주소가 되지만 화면 상태는 그대로다. 주소를 화면에 다시 맞춘다.
    const keep = () => {
      if (location.hash.replace(/\?.*$/, "").endsWith("/records")) replaceRouteParams(viewParams);
    };
    window.addEventListener("hashchange", keep);
    return () => window.removeEventListener("hashchange", keep);
  }, [viewParams]);
  // 경기 상세에서 뒤로 오면 떠날 때의 스크롤 위치로 돌아간다. 펼친 개수(n)도 주소에 있어 같은 위치가 같은 경기다.
  useScrollMemory();
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const tz = snapshot.group.timezone;

  const setFilter = (next: MatchFilter) => {
    setFilterState(next);
    setShown(PAGE);
  };

  const season = scope.kind === "season" ? snapshot.seasons.find((s) => s.id === scope.seasonId) : null;
  const scopeLabel = scopeLabelOf(snapshot, scope);
  // 경기 카드·순위표의 이름을 누르면 개인 통계를 지금 범위로 연다. 변경 내역의 이름은 범위와 무관해 그대로 연다.
  const openPersonInScope = (id: string) => props.openPerson(`${id}${scopeSuffix(scope)}`);
  const scoped = useMemo(() => matchesInScope(snapshot, scope), [snapshot, scope]);
  const ordered = useMemo(() => newestFirst(scoped), [scoped]);
  const filtered = useMemo(() => filterMatches(ordered, filter), [ordered, filter]);
  const filtering = isFilterActive(filter);
  const listed = filtered.slice(0, shown);
  const anchor = filter.people[0] ?? null;
  const anchorTally = useMemo(
    () => (anchor ? anchorRecord(filtered, anchor) : null),
    [filtered, anchor],
  );

  // 배치와 칭호는 범위와 무관하게 모임 전체 누적 기준이다.
  const placement = useMemo(() => standingsOf(snapshot), [snapshot]);
  // 순위는 배치 완료자를 먼저 두고 고른 기준으로 정렬한다. 범위 안에 경기가 없는 사람은 순위에 없다.
  // 라인을 고르면 그 라인으로 뛴 경기만 센다. 최근 흐름·연승도 같은 경기로 센다.
  const lineRecords = useMemo(() => lineRanking(scoped, line), [scoped, line]);
  const forms = useMemo(() => personForms(scoped, line), [scoped, line]);
  const noPosition = useMemo(() => (line ? matchesWithoutPositions(scoped) : 0), [scoped, line]);
  // MMR도 범위·라인과 무관하게 모임 전체 누적 확정 경기로 계산한다(rating.ts).
  const ratingOptions = ratingOptionsOf(snapshot.group.settings);
  const { placementGames } = ratingOptions;
  const ratings = useMemo(
    () => ratingValues(computeRatings(snapshot.matches, ratingOptionsOf(snapshot.group.settings))),
    [snapshot],
  );
  const ranking = useMemo(
    () => rankAndSearch(lineRecords, placement, nameOf, sort, query, ratings),
    [lineRecords, placement, nameOf, sort, query, ratings],
  );
  const records = ranking.shown;
  // 묶음(누적 50경기 이상 · 배치 완료 · 배치 진행 중)이 둘 이상이고 검색하지 않을 때만 묶음 소제목을 보인다.
  const groupHeads =
    query.trim() === "" && new Set(records.map((r) => rankingGroup(placement, r.participantId))).size > 1;
  // 변경 내역: 정정·제외·복구와, 합치기(한 번에 한 줄로 묶어 서버가 보냄).
  const changeLog = snapshot.revisions.filter((r) =>
    ["correction", "exclude", "restore", "merge", "merge_undo"].includes(r.kind),
  );

  // 경기가 한 번도 없으면(지운 경기의 변경 내역도 없으면) 빈 순위표·시리즈·변경 내역 대신 안내 하나만 둔다.
  // 행동은 머리의 "지난 경기 입력"(운영자) 하나다(CLAUDE.md 8절).
  const neverPlayed = snapshot.matches.length === 0 && changeLog.length === 0;
  const shareLink = filtering ? shareLinkOf(snapshot, viewParams) : null;

  return (
    <div className="screen cols records-screen">
      <ScreenHead
        title="기록"
        desc={
          <>
            {season
              ? `${season.name}: ${formatRange(season.startsOn, season.endsOn, snapshot.group.timezone)}`
              : `${scopeLabel} 경기와 사람별 순위`}
            {props.openSeason && (scope.kind === "season" || scope.kind === "year") && (
              <>
                {" · "}
                <button type="button" className="link inline-link" onClick={() => props.openSeason!(scope)}>
                  {scopeLabel} 요약과 시상 보기
                </button>
              </>
            )}
          </>
        }
        actions={
          <>
            {props.openBackfill && (
              <button type="button" className="primary" onClick={props.openBackfill}>
                지난 경기 입력
              </button>
            )}
            <button type="button" className="secondary" onClick={props.openGraphs}>
              그래프 분석
            </button>
          </>
        }
      />

      {neverPlayed ? (
        <div className="empty-state full">
          <p>
            아직 저장한 경기가 없어요. 경기 결과를 저장하면 경기 목록과 플레이어 랭킹이 여기에 쌓여요.
          </p>
        </div>
      ) : (
      <>
      <FilterBar label="보기 조건">
        <ScopePicker
          snapshot={snapshot}
          scope={scope}
          onChange={(next) => {
            setScope(next);
            setShown(PAGE);
          }}
        />
        {ordered.length > 0 && (
          <MatchFilterSelects scoped={scoped} filter={filter} onChange={setFilter} nameOf={nameOf} />
        )}
      </FilterBar>
      <ScopeBasis snapshot={snapshot} scope={scope} />

      <KpiStrip snapshot={snapshot} hideGames />

      <section className="rec-matches" aria-label="경기 목록">
        <h2>
          {/* 확정·미입력·제외 경기 수는 위 기준 줄(ScopeBasis)에 있다. 여기 다시 쓰면 같은 숫자가 두 번 보인다. */}
          {scope.kind === "today" ? "오늘의 결과" : `${scopeLabel} 경기`}
        </h2>
        <MatchFilterPeople filter={filter} onChange={setFilter} nameOf={nameOf} />
        {filtering && (
          <p className="filter-summary" role="status">
            <span>
              <strong>{filterText(filter, nameOf)}</strong> · {filtered.length}경기
              {/* 앞의 경기 수는 목록에 보이는 경기(결과 미입력·전적 제외 포함), 승패는 확정 경기만이라 괄호에 "확정"을 적는다.
                  검색 결과 줄의 "(40경기)"와 같은 숫자가 여기서 "43경기"와 나란히 나오면 왜 다른지 읽을 수 있어야 한다. */}
              {anchor && anchorTally && anchorTally.games > 0
                ? ` · ${nameOf(anchor)} ${rateText(anchorTally.wins, anchorTally.games)} · ${anchorTally.wins}승 ${anchorTally.games - anchorTally.wins}패 (확정 ${anchorTally.games}경기)`
                : anchor && filtered.length > 0
                  ? ` · ${nameOf(anchor)} 확정된 경기 없음`
                  : ""}
            </span>
            <span className="filter-actions">
              {shareLink && <CopyButton label="이 조건으로 공유" text={() => shareLink} />}
              <button type="button" className="link" onClick={() => setFilter(EMPTY_FILTER)}>
                조건 지우기
              </button>
            </span>
          </p>
        )}
        {ordered.length === 0 ? (
          <p className="hint">이 범위에는 기록이 없어요.</p>
        ) : filtered.length === 0 ? (
          <p className="hint">조건에 맞는 경기가 없어요. 조건을 줄이거나 범위를 넓혀 보세요.</p>
        ) : (
          <ul className="list match-cards">
            {listed.map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                nameOf={nameOf}
                timeZone={tz}
                showDate={scope.kind !== "today"}
                focusId={filter.people.length === 1 ? anchor : null}
                highlightIds={filter.people}
                onOpen={() => props.openMatch(m.id)}
                onPerson={openPersonInScope}
                seriesBadge={seriesBadge(m.id)}
                upset={expectation.get(m.id)?.upset}
                action={
                  m.state === "awaiting_result" && props.onResult ? (
                    <button type="button" className="secondary" onClick={() => props.onResult!(m)}>
                      결과 입력
                    </button>
                  ) : undefined
                }
              />
            ))}
          </ul>
        )}
        {filtered.length > listed.length && (
          <button type="button" className="link" onClick={() => setShown(shown + PAGE)}>
            나머지 {filtered.length - listed.length}경기 중 {Math.min(PAGE, filtered.length - listed.length)}경기
            더 보기
          </button>
        )}
        {filtered.length > 0 && (
          <p className="hint csv-row">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                downloadText(csvFileName("내전기록", snapshot), matchesCsv(snapshot, filtered))
              }
            >
              CSV 내려받기
            </button>
            <span>지금 범위·조건의 {filtered.length}경기 (더 보기로 열지 않은 경기 포함)</span>
          </p>
        )}
      </section>

      <section aria-label="플레이어 랭킹">
        <h2>
          플레이어 랭킹 ({scopeLabel}
          {line ? ` · ${POSITION_LABEL[line]}` : ""})
        </h2>
        <div className="rank-controls">
          <input
            type="search"
            className="filter-search"
            aria-label="이름 검색"
            placeholder="이름 검색"
            enterKeyHint="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={rankJump.onSearchKey}
          />
          <label className="rank-line">
            라인별
            <select
              aria-label="라인별 랭킹"
              value={line ?? ""}
              onChange={(e) => setLine((e.target.value || null) as Position | null)}
            >
              <option value="">모든 라인</option>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {POSITION_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="link" onClick={props.openRanking}>
            MMR 랭킹 전체 보기 →
          </button>
        </div>
        <p className="hint rank-rule">누적 {RANKING_VETERAN_GAMES}경기 이상인 사람을 먼저 보여줘요. 칭호·배치는 누적 기준이에요.</p>
        {sort === "rating" && (
          <p className="hint rating-rule">
            MMR은 팀원과 상대 팀이 누구였는지까지 감안해 전체 기록으로 계산한 실력 점수예요(시작 {ratingOptions.start}). 확정
            경기만 세고 범위와 무관하게 누적이에요. 3연승·3연패부터 그 경기를 더 무겁게 세어요(최대 1.5배). {RATING_TIER_HELP}
          </p>
        )}
        {scope.kind !== "all" && query.trim() !== "" && records.length === 0 && (
          <p className="hint">
            <button type="button" className="link" onClick={() => setScope({ kind: "all" })}>
              전체 범위에서 찾기
            </button>
          </p>
        )}
        <div ref={rankJump.results} tabIndex={-1} className="search-results">
          {ranking.ranked.length === 0 ? (
            <p className="hint">
              {line
                ? `이 범위에는 ${POSITION_LABEL[line]}(으)로 뛴 확정 경기가 없어요.`
                : "이 범위에는 확정된 경기가 없어요."}
            </p>
          ) : records.length === 0 ? (
            <p className="hint">일치하는 이름이 없어요.</p>
          ) : (
            <div className="dt-list rank-table">
              <SortHead
                label="랭킹 정렬"
                className="rank-grid"
                sort={{ key: sort, dir: "desc" }}
                onSort={setSort}
                cells={[
                  { cls: "c-rank", label: "#" },
                  { cls: "c-who", label: "이름 · 최근 승패" },
                  { cls: "c-rate", label: RANK_COLUMN_LABEL.rate, sort: "rate", num: true },
                  { cls: "c-wins", label: RANK_COLUMN_LABEL.wins, sort: "wins", num: true },
                  { cls: "c-games", label: RANK_COLUMN_LABEL.games, sort: "games", num: true },
                  { cls: "c-mmr", label: RANK_COLUMN_LABEL.rating, sort: "rating", num: true },
                ]}
              />
              <ul className="list list-card">
                {records.map((r, i) => {
                  const form = forms.get(r.participantId);
                  const streak = form?.currentStreak ?? 0;
                  const standing = placement.get(r.participantId);
                  const rating = ratings.get(r.participantId);
                  // 검색하지 않을 때만 묶음이 바뀌는 자리에 얇은 소제목을 둔다(검색 결과는 일치도 순이라 섞인다).
                  const group = rankingGroup(placement, r.participantId);
                  const prev = i > 0 ? rankingGroup(placement, records[i - 1]!.participantId) : null;
                  const showGroup = groupHeads && group !== prev;
                  return (
                    <Fragment key={r.participantId}>
                      {showGroup && (
                        // 순위 줄 개수(listitem)에 섞이지 않도록 소제목은 목록 항목 역할을 갖지 않는다.
                        <li className="rank-group" role="presentation">
                          {RANKING_GROUP_LABEL[group]}
                        </li>
                      )}
                      <li>
                        {/* 줄 전체가 개인 통계로 가는 버튼. 칸 사이 이음 글자(Glue) 덕에 버튼 이름과 글자 내용은
                            "70% · 7승 3패 (10경기)"처럼 예전 한 줄 모양 그대로 읽힌다. */}
                        <button
                          type="button"
                          className="list-row rank-row rank-grid"
                          onClick={() => openPersonInScope(r.participantId)}
                        >
                          <span className={`c-rank ${rankClass(r.rank)}`}>{r.rank}</span>
                          <span className="c-who">
                            <span className="rank-line1">
                              <span className="rank-person">{r.name}</span>
                              <FormDots results={recentResults(form)} />
                              {Math.abs(streak) >= 2 && (
                                <span className={streak > 0 ? "streak win" : "streak loss"}>{streakText(streak)}</span>
                              )}
                            </span>
                            <span className="rank-sub">
                              <StandingNote standing={standing} placementGames={placementGames} compact basisInHeading />
                            </span>
                          </span>
                          <span className="rank-stat">
                            <span className="c-rate num">
                              <span className={rateHueText(r.wins, r.games)}>{rateText(r.wins, r.games)}</span>
                              <Glue> · </Glue>
                            </span>
                            <span className="c-wins num">
                              {r.wins}승 {r.losses}패<Glue> (</Glue>
                            </span>
                            <span className="c-games num">
                              {r.games}
                              <Glue>경기)</Glue>
                            </span>
                          </span>
                          <span className="c-mmr num">
                            {rating !== undefined && (
                              <>
                                {/* 누적 MMR. 배치 진행 중이면 흐리게 둔다(아직 많이 흔들리는 값). */}
                                <span className={standing?.done ? "rating-num" : "rating-num hint"}>
                                  <Glue>MMR </Glue>
                                  {shownRating(rating)}
                                </span>{" "}
                                <RatingTierBadge rating={rating} placed={standing?.done === true} />
                              </>
                            )}
                          </span>
                        </button>
                      </li>
                    </Fragment>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
        {records.length > 0 && (
          <p className="hint csv-row">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                downloadText(csvFileName("내전랭킹", snapshot), rankingCsv(records, placement, ratings))
              }
            >
              CSV 내려받기
            </button>
            <span>보이는 순위표 {records.length}명</span>
          </p>
        )}
        <Help label="순서와 표시 규칙">
          순서: 누적 {RANKING_VETERAN_GAMES}경기 이상 → 배치 완료(누적 {placementGames}경기 이상) → 배치 진행 중, 묶음 안에서는 {RANKING_SORT_LABEL[sort]}
          {sort === "rate" ? " → 경기 수 → 이름" : sort === "games" ? " → 승률 → 이름" : " → 승률 → 경기 수 → 이름"}.
          이름을 검색하면 일치하는 순으로 보여주고 순위 숫자는 바뀌지 않아요. 승·패 칸은 최근 경기가
          왼쪽이며, 2경기 이상 이어지면 연승·연패를 적어요. 결과 미입력·전적 제외 경기는 세지 않아요.
          {line && noPosition > 0
            ? ` 포지션 기록이 없는 ${noPosition}경기는 라인별 순위에서 빠져요.`
            : ""}
        </Help>
      </section>

      <SeriesListSection
        snapshot={snapshot}
        scoped={scoped}
        nameOf={nameOf}
        openMatch={props.openMatch}
        app={props.app ?? null}
      />

      <details>
        <summary>변경 내역</summary>
        {changeLog.length === 0 ? (
          <p className="hint">정정·제외·복구한 기록이 없어요.</p>
        ) : (
          <ul className="list">
            {changeLog.map((r) => {
              if (r.merge) {
                const { sourceId, targetId, matchCount } = r.merge;
                return (
                  <li key={r.id}>
                    <button type="button" className="list-row" onClick={() => props.openPerson(targetId)}>
                      <span>
                        {r.kind === "merge_undo"
                          ? `${nameOf(sourceId)}${objectParticle(nameOf(sourceId))} ${nameOf(targetId)}에게 합친 것을 되돌림 (${matchCount}경기)`
                          : `${nameOf(sourceId)}${objectParticle(nameOf(sourceId))} ${nameOf(targetId)}에게 합침 (${matchCount}경기)`}
                        <br />
                        <span className="hint">중복 참가자 합치기 · 승패는 그대로</span>
                      </span>
                      <span className="hint">
                        {formatDate(r.createdAt, tz)} {formatTime(r.createdAt, tz)}
                      </span>
                    </button>
                  </li>
                );
              }
              if (deletionOf(r) !== null) {
                return <DeletionRow key={r.id} revision={r} timeZone={tz} app={props.app ?? null} />;
              }
              const match = snapshot.matches.find((m) => m.id === r.matchId);
              return (
                <li key={r.id}>
                  <button type="button" className="list-row" onClick={() => props.openMatch(r.matchId)}>
                    <span>
                      {r.matchNo}경기 · {REVISION_LABEL[r.kind] ?? r.kind}
                      {r.kind === "correction"
                        ? ` (${Object.keys(r.changes)
                            .map((k) => changeText(k, nameOf, match))
                            .join(", ")})`
                        : ""}
                      <br />
                      <span className="hint">현재: {match ? resultLine(match) : ""}</span>
                    </span>
                    <span className="hint">
                      {formatDate(r.createdAt, tz)} {formatTime(r.createdAt, tz)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="hint">
          수치가 달라 보이면 범위(오늘·전체)를 바꿨거나 위 목록처럼 경기 자체가 바뀐 것이에요.
        </p>
      </details>
      </>
      )}
    </div>
  );
}

/**
 * 변경 내역의 경기 삭제·되살리기 줄. 지운 경기는 목록에 없어 누를 경기가 없으므로 정적인 줄이고,
 * 지금도 지워져 있는 경기의 가장 최근 삭제 줄(revision.deletedMatch)에만 운영자에게 "되살리기"를 둔다.
 */
function DeletionRow(props: { revision: RevisionView; timeZone: string; app: AppValue | null }) {
  const { revision: r, app } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // 응답을 못 받아 다시 누르면 같은 요청 ID로 보낸다(서버가 같은 응답을 돌려준다).
  const requestId = useRef<string | null>(null);
  const deleted = deletionOf(r) === true;
  const by = DELETED_BY_LABEL[String(r.changes.by?.to)] ?? "운영자";

  async function undelete() {
    if (!app || !r.deletedMatch) return;
    requestId.current ??= newRequestId();
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${app.groupId}/matches/${r.matchId}/undelete`, {
        requestId: requestId.current,
        baseMatchVersion: r.deletedMatch.version,
      });
      requestId.current = null;
      app.setNotice(`${r.matchNo}경기를 되살렸어요. 목록과 통계에 다시 들어가요.`);
      await app.refreshAfterOwnChange();
    } catch (e) {
      setError(e);
      if (e instanceof ApiFailure && e.code === "VERSION_CONFLICT") void app.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="list-row static">
      <div>
        {r.matchNo}경기 · {deleted ? "삭제" : "삭제 되살림"}
        <br />
        <span className="hint">
          {by} · {formatDate(r.createdAt, props.timeZone)} {formatTime(r.createdAt, props.timeZone)}
        </span>
        <ErrorNote error={error} onCheck={() => void app?.refresh()} />
      </div>
      {app && r.deletedMatch && (
        <button type="button" className="secondary" disabled={busy} onClick={() => void undelete()}>
          <span aria-hidden="true">{busy ? "되살리는 중" : "되살리기"}</span>
          <span className="sr-only">{r.matchNo}경기 되살리기</span>
        </button>
      )}
    </li>
  );
}
