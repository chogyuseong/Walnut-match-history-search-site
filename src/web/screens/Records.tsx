import { Fragment, useMemo, useRef, useState } from "react";
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
  type WinnerSideFilter,
} from "../../shared/insights";
import { computeRatings, ratingValues, shownRating, ratingOptionsOf, RATING_TIER_HELP } from "../../shared/rating";
import {
  fractionPercent,
  matchesInScope,
  scopeLabel as scopeLabelOf,
  zonedDateTimeInput,
  zonedInputToUtc,
  type Scope,
} from "../../shared/stats";
import {
  POSITIONS,
  sideOfTeam,
  type MatchView,
  type Position,
  type RevisionView,
  type Side,
  type Snapshot,
  type Team,
} from "../../shared/types";
import { championName } from "../../shared/champions";
import { ApiFailure, mutate, newRequestId } from "../api";
import { ChampionFields } from "../championPicker";
import { ChampionPortrait } from "../championPortrait";
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
  SIDE_LABEL,
  standingsOf,
  STATE_LABEL,
  teamName,
  teamRoster,
} from "../format";
import { csvFileName, downloadText, matchesCsv, rankingCsv } from "../csvExport";
import { MatchCard, useExpectations } from "../matchCard";
import { expectedOf, UPSET_MMR_GAP, type MatchExpectation } from "../../shared/upset";
import { MatchMemoSection } from "../memoField";
import { MatchSeriesSection, SeriesListSection, useSeriesBadges } from "../seriesPanel";
import { drawMatchImage, fileDate, ShareImageDialog } from "../shareImage";
import {
  BackLink,
  FilterBar,
  FormDots,
  Glue,
  Help,
  KpiStrip,
  MatchTeams,
  RatingTierBadge,
  ScopePicker,
  ScreenHead,
  SortHead,
  StandingNote,
} from "../screenKit";
import { Dialog, ErrorNote, useSearchJump } from "../ui";
import type { AppValue } from "../useApp";
import { ResultSheet } from "./ResultSheet";

const REVISION_LABEL: Record<string, string> = {
  start: "경기 시작",
  end: "경기 종료(결과 미입력)",
  result: "결과 확정",
  correction: "정정",
  exclude: "전적 제외",
  restore: "복구",
  cancel: "미진행 취소",
  backfill: "지난 경기 입력",
};

/**
 * 경기 삭제·되살리기 줄(src/server/matches.ts deleteMatch가 kind "correction"에 changes.deleted로 남긴다)이면
 * 지운 줄은 true, 되살린 줄은 false. 그 밖의 줄은 null.
 */
function deletionOf(r: RevisionView): boolean | null {
  const change = r.changes.deleted;
  return change ? change.to === true : null;
}

/** 삭제·되살리기 줄의 changes.by(누가 했는지). 계정은 남기지 않고 역할만 남는다. */
const DELETED_BY_LABEL: Record<string, string> = { owner: "대표 운영자", co: "공동 운영자" };

function changeText(key: string, nameOf: (id: string) => string, match: MatchView | undefined): string {
  if (key === "winnerTeam") return "승리 팀";
  if (key === "teamASide") return "진영";
  if (key === "playedAt") return "경기 시각";
  if (key === "participant") return "참가자";
  if (key === "state") return "상태";
  if (key.startsWith("position:")) return `${nameOf(key.slice(9))}의 포지션`;
  if (key.startsWith("rotation:")) {
    const team = key.slice(9);
    const name = team === "A" || team === "B" ? teamName(team, match?.teamASide) : `팀 ${team}`;
    return `${name} 서포터 횟수 기록`;
  }
  return key;
}

/** 한 번에 보여주는 경기 카드 수. "더 보기"로 같은 수만큼 더 연다. */
const PAGE = 30;

const WINNER_SIDE_LABEL: Record<WinnerSideFilter, string> = {
  blue: "블루 승",
  red: "레드 승",
  unknown: "진영 미상",
};

/** 거른 조건을 한 줄 글로. */
function filterText(filter: MatchFilter, nameOf: (id: string) => string): string {
  const parts: string[] = [];
  const [anchor] = filter.people;
  if (filter.people.length === 1) parts.push(`${nameOf(anchor!)} 참가`);
  if (filter.people.length > 1) parts.push(`${filter.people.map(nameOf).join("·")} 모두 참가`);
  if (anchor && filter.position) parts.push(`${nameOf(anchor)} ${POSITION_LABEL[filter.position]}`);
  if (anchor && filter.result) parts.push(`${nameOf(anchor)} ${filter.result === "win" ? "승" : "패"}`);
  if (filter.winnerSide) parts.push(WINNER_SIDE_LABEL[filter.winnerSide]);
  return parts.join(" · ");
}

/** 경기에 나온 사람(이름순). 거를 사람 고르기의 선택지. */
function useCandidates(scoped: readonly MatchView[], nameOf: (id: string) => string): string[] {
  return useMemo(() => {
    const ids = new Set<string>();
    for (const m of scoped) for (const r of m.roster) ids.add(r.participantId);
    return [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b), "ko"));
  }, [scoped, nameOf]);
}

/**
 * 경기 거르기 중 화면 맨 위 필터 줄에 들어가는 두 칸: 사람(여러 명이면 모두 함께 뛴 경기)·이긴 팀의 진영.
 * 고른 사람 칩과 첫 번째 사람의 라인·승패는 경기 목록 위(MatchFilterPeople)에 둔다(사람을 고른 뒤에만 생긴다).
 */
function MatchFilterSelects(props: {
  scoped: readonly MatchView[];
  filter: MatchFilter;
  onChange: (filter: MatchFilter) => void;
  nameOf: (id: string) => string;
}) {
  const { filter, onChange, nameOf } = props;
  const candidates = useCandidates(props.scoped, nameOf);
  const hasPerson = filter.people.length > 0;
  return (
    <>
      <label>
        사람
        <select
          aria-label="거를 사람 추가"
          value=""
          onChange={(e) => {
            if (e.target.value === "") return;
            onChange({ ...filter, people: [...filter.people, e.target.value] });
          }}
        >
          <option value="">{hasPerson ? "함께 뛴 사람 추가" : "사람 고르기"}</option>
          {candidates
            .filter((id) => !filter.people.includes(id))
            .map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
        </select>
      </label>
      <label>
        이긴 진영
        <select
          aria-label="이긴 진영"
          value={filter.winnerSide ?? ""}
          onChange={(e) =>
            onChange({ ...filter, winnerSide: (e.target.value || null) as WinnerSideFilter | null })
          }
        >
          <option value="">진영 모두</option>
          <option value="blue">블루 승</option>
          <option value="red">레드 승</option>
          <option value="unknown">진영 미상</option>
        </select>
      </label>
    </>
  );
}

/** 고른 사람 칩과 첫 번째 사람의 라인·승패. 사람을 고르기 전에는 그리지 않는다. */
function MatchFilterPeople(props: {
  filter: MatchFilter;
  onChange: (filter: MatchFilter) => void;
  nameOf: (id: string) => string;
}) {
  const { filter, onChange, nameOf } = props;
  if (filter.people.length === 0) return null;
  const anchorName = nameOf(filter.people[0]!);
  return (
    <div className="match-filter" role="group" aria-label="경기 거르기">
      <div className="filter-people">
        {filter.people.map((id, i) => (
          <button
            key={id}
            type="button"
            className="chip"
            aria-label={`${nameOf(id)} 조건 빼기`}
            onClick={() => {
              const people = filter.people.filter((p) => p !== id);
              // 기준(첫 사람)이 바뀌면 그 사람에게 걸린 라인·승패 조건도 지운다.
              onChange(
                i === 0
                  ? { ...filter, people, position: null, result: null }
                  : { ...filter, people },
              );
            }}
          >
            {i === 0 && filter.people.length > 1 ? "기준 " : ""}
            {nameOf(id)} <span aria-hidden="true">×</span>
          </button>
        ))}
      </div>
      <div className="filter-row">
        <label>
          {anchorName}의 라인
          <select
            aria-label="라인"
            value={filter.position ?? ""}
            onChange={(e) =>
              onChange({ ...filter, position: (e.target.value || null) as Position | null })
            }
          >
            <option value="">라인 모두</option>
            {POSITIONS.map((p) => (
              <option key={p} value={p}>
                {POSITION_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {anchorName}의 승패
          <select
            aria-label="승패"
            value={filter.result ?? ""}
            onChange={(e) =>
              onChange({
                ...filter,
                result: (e.target.value || null) as MatchFilter["result"],
              })
            }
          >
            <option value="">승패 모두</option>
            <option value="win">승</option>
            <option value="loss">패</option>
          </select>
        </label>
      </div>
    </div>
  );
}

/** 소환사 랭킹 머리 줄의 정렬 열 이름. 정렬 이름(RANKING_SORT_LABEL, 도움말에 쓴다)과 달리 열 머리라 "MMR"만 쓴다. */
const RANK_COLUMN_LABEL: Record<RankingSort, string> = { rate: "승률", wins: "승수", games: "경기 수", rating: "MMR" };

/**
 * 화면 6 — 기록. 운영자와 조회자가 같은 화면을 본다.
 * 틀(2026-11-10 구조 정리): 화면 머리(운영자는 오른쪽에 "지난 경기 입력") → 필터 줄 하나(범위·사람·이긴 진영) → 누적 띠 →
 * PC 2단(왼쪽 좁은 단 경기 카드 목록, 오른쪽 넓은 단 소환사 랭킹 표). 소환사 랭킹은 열 머리를 눌러 정렬한다.
 */
export function Records(props: {
  snapshot: Snapshot;
  openMatch: (id: string) => void;
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
  // 최근 세션에 경기가 없으면 "오늘"이 비어 보이므로 전체로 연다.
  const [scope, setScope] = useState<Scope>(() =>
    matchesInScope(snapshot, { kind: "today" }).length > 0 ? { kind: "today" } : { kind: "all" },
  );
  const [shown, setShown] = useState(PAGE);
  const [query, setQuery] = useState("");
  const rankJump = useSearchJump<HTMLDivElement>();
  const [filter, setFilterState] = useState<MatchFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<RankingSort>("rate");
  const [line, setLine] = useState<Position | null>(null);
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const tz = snapshot.group.timezone;

  const setFilter = (next: MatchFilter) => {
    setFilterState(next);
    setShown(PAGE);
  };

  const season = scope.kind === "season" ? snapshot.seasons.find((s) => s.id === scope.seasonId) : null;
  const scopeLabel = scopeLabelOf(snapshot, scope);
  const scoped = useMemo(() => matchesInScope(snapshot, scope), [snapshot, scope]);
  const ordered = useMemo(() => newestFirst(scoped), [scoped]);
  const filtered = useMemo(() => filterMatches(ordered, filter), [ordered, filter]);
  const filtering = isFilterActive(filter);
  const listed = filtered.slice(0, shown);
  const confirmed = scoped.filter((m) => m.state === "confirmed").length;
  const awaiting = scoped.filter((m) => m.state === "awaiting_result").length;
  const excluded = scoped.filter((m) => m.state === "excluded").length;
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
            아직 저장한 경기가 없어요. 경기 결과를 저장하면 경기 목록과 소환사 랭킹이 여기에 쌓여요.
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

      <KpiStrip snapshot={snapshot} />

      <section className="rec-matches" aria-label="경기 목록">
        <h2>
          {scope.kind === "today" ? "오늘의 결과" : `${scopeLabel} 경기`} · {confirmed}경기 확정
          {awaiting > 0 ? ` · 결과 미입력 ${awaiting}` : ""}
          {excluded > 0 ? ` · 전적 제외 ${excluded}` : ""}
        </h2>
        <MatchFilterPeople filter={filter} onChange={setFilter} nameOf={nameOf} />
        {filtering && (
          <p className="filter-summary" role="status">
            <span>
              <strong>{filterText(filter, nameOf)}</strong> · {filtered.length}경기
              {anchor && anchorTally && anchorTally.games > 0
                ? ` · ${nameOf(anchor)} ${rateText(anchorTally.wins, anchorTally.games)} · ${anchorTally.wins}승 ${anchorTally.games - anchorTally.wins}패 (${anchorTally.games}경기)`
                : ""}
            </span>
            <button type="button" className="link" onClick={() => setFilter(EMPTY_FILTER)}>
              조건 지우기
            </button>
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
                onPerson={props.openPerson}
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

      <section aria-label="소환사 랭킹">
        <h2>
          소환사 랭킹 ({scopeLabel}
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
        <p className="hint rank-rule">누적 {RANKING_VETERAN_GAMES}경기 이상인 사람을 먼저 보여줘요.</p>
        {sort === "rating" && (
          <p className="hint rating-rule">
            MMR은 팀원과 상대 팀이 누구였는지까지 감안해 전체 기록으로 계산한 실력 점수예요(시작 {ratingOptions.start}). 확정
            경기만 세고 범위와 무관하게 누적입니다. 3연승·3연패부터 그 경기를 더 무겁게 셉니다(최대 1.5배). {RATING_TIER_HELP}
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
                          onClick={() => props.openPerson(r.participantId)}
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
                              <StandingNote standing={standing} placementGames={placementGames} compact />
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
          이름을 검색하면 일치하는 순으로 보여주고 순위 숫자는 바뀌지 않습니다. 승·패 칸은 최근 경기가
          왼쪽이며, 2경기 이상 이어지면 연승·연패를 적습니다. 결과 미입력·제외 경기는 세지 않습니다.
          {line && noPosition > 0
            ? ` 포지션 기록이 없는 ${noPosition}경기는 라인별 순위에서 빠집니다.`
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
          수치가 달라 보이면 범위(오늘·전체)를 바꿨거나 위 목록처럼 경기 자체가 바뀐 것입니다.
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

type Editing = null | "winner" | "side" | "positions" | "participant" | "playedAt" | "champions";

/** 경기의 챔피언 기록({ 참가자 ID: 챔피언 키 }, 고른 사람만). 챔피언 저장 요청의 본문 모양이다. */
function championsOf(match: MatchView): Record<string, string> {
  return Object.fromEntries(match.roster.flatMap((r) => (r.champion ? [[r.participantId, r.champion]] : [])));
}

function sameChampions(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** 경기 상세 목록 줄의 요약: "기록 없음" 또는 "10명 중 4명". 이름별 챔피언은 위의 팀 판에 있다. */
function championSummary(match: MatchView): string {
  const count = match.roster.filter((r) => r.champion).length;
  return count === 0 ? "기록 없음" : `${match.roster.length}명 중 ${count}명`;
}

/**
 * 경기 전 예상 한 줄(이변 지수, src/shared/upset.ts): "경기 전 예상 블루 62% : 레드 38%"와 이변 배지.
 * 진영을 모르면 팀 A·B로 쓴다. 예상이 없으면(유효 확정 경기가 아님) 줄을 그리지 않고,
 * 열 명 모두 배치 중이면 숫자 대신 "예상 없음"을 쓴다(판정하지 않음).
 */
function ExpectationLine(props: { expectation: MatchExpectation | undefined }) {
  const e = props.expectation;
  if (!e) return null;
  if (!e.reliable) {
    return <p className="hint">경기 전 예상 없음 · 열 명 모두 배치 중이라 판정하지 않아요</p>;
  }
  // 블루를 앞에 둔다. 앞쪽 숫자를 반올림하고 뒤쪽은 100 − 앞쪽(합이 101%가 되지 않게).
  const first: Team = e.teamASide === "red" ? "B" : "A";
  const second: Team = first === "A" ? "B" : "A";
  const firstPct = fractionPercent(expectedOf(e, first));
  const upsetRule = `이긴 쪽의 팀 평균 MMR이 ${shownRating(e.winnerDeficit)}점 낮았어요(${UPSET_MMR_GAP}점 이상 낮은 팀이 이기면 이변)`;
  return (
    <>
      <p className="hint expectation-line">
        경기 전 예상 {teamName(first, e.teamASide).replace(/팀$/, "")} {firstPct}% :{" "}
        {teamName(second, e.teamASide).replace(/팀$/, "")} {100 - firstPct}%
        {e.upset && (
          <>
            {" "}
            <span className="series-badge" title={upsetRule}>
              이변
            </span>
          </>
        )}
        {/* F6(2026-11-10): 그때 화면에 떴던 값이 아니다. 뒤에 정정하거나 설정을 바꾸면 이 값도 바뀐다. */}
        <span className="expectation-note"> · 지금 기록과 설정으로 다시 계산한 값</span>
      </p>
      {/* 이변 배지의 기준은 title 풍선이라 터치 화면에서 보이지 않아 접힌 도움말에도 둔다. */}
      {e.upset && (
        <Help label="이변 기준">
          {/* 판정은 점수, %는 보정 확률로 나눈 이유: upset.ts 머리 주석. */}
          {upsetRule}. 목록의 "이변" 배지도 같은 기준이고, 모든 모임이 같은 점수로 판정해요. 위의 %는 팀 MMR 차로 구한
          승률을 이 모임 지난 경기 결과에 맞춰 보정한 값이라(준비 화면 예상 승률과 같은 방식) 이변 경기도 50%에 가깝게 나올 수 있어요.
        </Help>
      )}
    </>
  );
}

/** 경기 상세. 운영자에게는 항목 옆에 [수정]이 있다. 조회자는 읽기만 한다. */
export function MatchDetail(props: {
  snapshot: Snapshot;
  matchId: string;
  app: AppValue | null;
  back: () => void;
  /** 같은 시리즈의 다른 판으로 간다. */
  openMatch: (id: string) => void;
}) {
  const { snapshot, app } = props;
  const match = snapshot.matches.find((m) => m.id === props.matchId) ?? null;
  const nameOf = nameMap(snapshot);
  const tz = snapshot.group.timezone;
  const [editing, setEditing] = useState<Editing>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [side, setSide] = useState<Side | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [outId, setOutId] = useState<string | null>(null);
  const [playedInput, setPlayedInput] = useState("");
  // 챔피언 수정 창에서 고르는 중인 값({ 참가자 ID: 챔피언 키 }).
  const [championDraft, setChampionDraft] = useState<Record<string, string>>({});
  const [imageOpen, setImageOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const expectationOf = useExpectations(snapshot);
  // 요청 ID는 같은 요청(동작·내용·경기 버전)을 다시 보낼 때 같은 값을 쓴다. 성공하거나 내용이 바뀌면 새로 만든다.
  const request = useRef<{ id: string; key: string } | null>(null);

  if (!match) {
    return (
      <div className="screen">
        <BackLink label="← 기록" fallback={props.back} />
        <p>경기를 찾을 수 없어요.</p>
      </div>
    );
  }
  const operator = app !== null;
  const history = snapshot.revisions.filter((r) => r.matchId === match.id);
  const winnerSide = match.winnerTeam ? sideOfTeam(match.winnerTeam, match.teamASide) : null;

  function closeEdit() {
    setEditing(null);
    setPending(null);
    setSide(null);
    setPicked([]);
    setOutId(null);
    setError(null);
  }

  async function send(action: string, body: Record<string, unknown>) {
    if (!app) return;
    const key = `${match!.id}:${match!.version}:${action}:${JSON.stringify(body)}`;
    if (!request.current || request.current.key !== key) request.current = { id: newRequestId(), key };
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${snapshot.group.id}/matches/${match!.id}/${action}`, {
        requestId: request.current.id,
        baseMatchVersion: match!.version,
        ...body,
      });
      request.current = null;
      await app.refreshAfterOwnChange();
      closeEdit();
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "ROTATION_DECISION_REQUIRED") {
        // 이 정정으로 서포터가 바뀐다. 차례 기록을 어떻게 할지 묻는다.
        setPending(body);
      } else {
        setError(e);
        if (e instanceof ApiFailure && e.code === "VERSION_CONFLICT") void app.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * 경기 삭제(src/server/matches.ts deleteMatch). 성공하면 기록 화면으로 먼저 돌아간 뒤 새로 읽는다: 새로 읽은 다음에
   * 돌아가면 그 사이 이 화면이 "경기를 찾을 수 없어요"로 한 번 그려진다.
   */
  async function deleteThisMatch() {
    if (!app) return;
    const key = `${match!.id}:${match!.version}:delete`;
    if (!request.current || request.current.key !== key) request.current = { id: newRequestId(), key };
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${snapshot.group.id}/matches/${match!.id}/delete`, {
        requestId: request.current.id,
        baseMatchVersion: match!.version,
      });
      request.current = null;
      app.setNotice(`${match!.matchNo}경기를 지웠어요. 기록 화면의 변경 내역에서 되살릴 수 있어요.`);
      props.back();
      await app.refreshAfterOwnChange();
    } catch (e) {
      setError(e);
      if (e instanceof ApiFailure && e.code === "VERSION_CONFLICT") void app.refresh();
    } finally {
      setBusy(false);
    }
  }

  const sameTeam =
    picked.length === 2 &&
    match.roster.find((r) => r.participantId === picked[0])?.team ===
      match.roster.find((r) => r.participantId === picked[1])?.team;

  const inCandidates = snapshot.participants.filter(
    (p) => p.status === "active" && !match.roster.some((r) => r.participantId === p.id),
  );

  return (
    <div className="screen">
      <header className="screen-head">
        <BackLink label="← 기록" fallback={props.back} />
        <h1>{match.matchNo}경기</h1>
        <span className="badge">{STATE_LABEL[match.state]}</span>
      </header>

      <p className="hint">
        {formatDate(match.playedAt, tz)} {formatTime(match.playedAt, tz)}
        {match.source === "backfill" ? " · 지난 경기 입력" : ""}
        {match.source === "import" ? " · 이관" : ""}
      </p>

      <MatchTeams
        match={match}
        nameOf={nameOf}
        championName={championName}
        championPortrait={(key) => <ChampionPortrait championKey={key} size={32} />}
      />

      <ExpectationLine expectation={expectationOf.get(match.id)} />

      {match.state === "confirmed" && (
        <div className="button-row">
          <button type="button" className="secondary" onClick={() => setImageOpen(true)}>
            결과 이미지
          </button>
        </div>
      )}
      {imageOpen && (
        <ShareImageDialog
          title={`${match.matchNo}경기 결과 이미지`}
          fileName={`${match.matchNo}경기-${fileDate(match.playedAt, tz)}.png`}
          make={() => drawMatchImage(snapshot, match)}
          onClose={() => setImageOpen(false)}
        />
      )}

      {match.state === "confirmed" && (
        <ul className="list">
          <li className="list-row static">
            <span>승리 팀: {teamName(match.winnerTeam!, match.teamASide)}</span>
            {operator && (
              <button type="button" className="secondary" onClick={() => setEditing("winner")}>
                수정
              </button>
            )}
          </li>
          <li className="list-row static">
            <span>승리 팀의 진영: {SIDE_LABEL[winnerSide ?? "unknown"]}</span>
            {operator && (
              <button type="button" className="secondary" onClick={() => setEditing("side")}>
                수정
              </button>
            )}
          </li>
          {operator && (
            <li className="list-row static">
              <span>
                경기 시각: {formatDate(match.playedAt, tz)} {formatTime(match.playedAt, tz)}
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  // 입력 칸은 화면에 보이는 시각과 같은 모임 시간대로 채운다(기기 시간대가 아니다).
                  setPlayedInput(zonedDateTimeInput(match.playedAt, tz));
                  setEditing("playedAt");
                }}
              >
                수정
              </button>
            </li>
          )}
          {operator && (
            <li className="list-row static">
              <span>포지션·참가자</span>
              <span className="button-row">
                <button type="button" className="secondary" onClick={() => setEditing("positions")}>
                  포지션 수정
                </button>
                <button type="button" className="secondary" onClick={() => setEditing("participant")}>
                  참가자 교체
                </button>
              </span>
            </li>
          )}
          {operator && (
            <li className="list-row static">
              <span>챔피언: {championSummary(match)}</span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setChampionDraft(championsOf(match));
                  setEditing("champions");
                }}
              >
                <span aria-hidden="true">{match.roster.some((r) => r.champion) ? "수정" : "기록"}</span>
                <span className="sr-only">{match.roster.some((r) => r.champion) ? "챔피언 수정" : "챔피언 기록"}</span>
              </button>
            </li>
          )}
        </ul>
      )}

      {operator && match.state === "awaiting_result" && (
        <button type="button" className="primary wide" onClick={() => setResultOpen(true)}>
          결과 입력
        </button>
      )}

      {operator && (match.state === "confirmed" || match.state === "awaiting_result" || match.state === "excluded") && (
        <details>
          <summary>더보기</summary>
          {match.state !== "excluded" && (
            <div className="button-row">
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void send("exclude", {})}
              >
                전적 제외
              </button>
              <span className="hint">
                통계와 배치 판수에서 빠집니다. 서포터 횟수는 그대로이고 언제든 복구할 수 있어요.
              </span>
            </div>
          )}
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                setError(null);
                setDeleteOpen(true);
              }}
            >
              경기 삭제
            </button>
            <span className="hint">
              잘못 넣은 경기를 지웁니다. 목록과 통계에서 사라지고, 변경 내역에서 되살릴 수 있어요.
            </span>
          </div>
        </details>
      )}
      {operator && match.state === "excluded" && (
        <p className="note">
          전적에서 제외된 경기입니다.{" "}
          <button type="button" className="link" disabled={busy} onClick={() => void send("restore", {})}>
            복구
          </button>
        </p>
      )}
      {editing === null && !deleteOpen && <ErrorNote error={error} />}
      {deleteOpen && (
        <Dialog title={`${match.matchNo}경기 삭제`} onClose={() => setDeleteOpen(false)}>
          <p>
            {formatDate(match.playedAt, tz)} {formatTime(match.playedAt, tz)} · {STATE_LABEL[match.state]}
          </p>
          <MatchTeams match={match} nameOf={nameOf} />
          <p className="note">
            목록·랭킹·통계와 조회 링크에서 사라져요. 경기 번호는 비워 두고, 기록 화면의 변경 내역에서 되살릴 수 있어요.
          </p>
          <ErrorNote error={error} />
          <div className="button-row">
            <button type="button" className="danger" disabled={busy} onClick={() => void deleteThisMatch()}>
              {busy ? "지우는 중" : "삭제"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setDeleteOpen(false)}>
              그만두기
            </button>
          </div>
        </Dialog>
      )}

      <MatchMemoSection key={`memo-${match.id}`} match={match} app={app} />
      <MatchSeriesSection
        key={`series-${match.id}`}
        snapshot={snapshot}
        match={match}
        app={app}
        nameOf={nameOf}
        openMatch={props.openMatch}
      />

      <details open={history.length > 0 && history.some((r) => r.kind === "correction")}>
        <summary>변경 이력 {history.length}건</summary>
        <ul className="list">
          {history.map((r) => (
            <li key={r.id} className="list-row static">
              <span>
                {deletionOf(r) !== null
                  ? `${deletionOf(r) ? "삭제" : "삭제 되살림"} · ${DELETED_BY_LABEL[String(r.changes.by?.to)] ?? "운영자"}`
                  : (REVISION_LABEL[r.kind] ?? r.kind) +
                    (Object.keys(r.changes).length > 0 && r.kind === "correction"
                      ? ` · ${Object.keys(r.changes)
                          .map((k) => changeText(k, nameOf, match))
                          .join(", ")}`
                      : "")}
              </span>
              <span className="hint">
                {formatDate(r.createdAt, tz)} {formatTime(r.createdAt, tz)}
              </span>
            </li>
          ))}
        </ul>
      </details>

      {resultOpen && (
        <ResultSheet
          match={match}
          mode="result"
          nameOf={nameOf}
          onClose={() => setResultOpen(false)}
        />
      )}
      {editing === "winner" && (
        <ResultSheet match={match} mode="correct" nameOf={nameOf} onClose={closeEdit} />
      )}

      {editing === "side" && (
        <Dialog title="진영 수정" onClose={closeEdit}>
          <p className="note">진영만 변경합니다. 개인 승패는 유지되고 진영 통계가 다시 계산됩니다.</p>
          <fieldset>
            <legend>
              이긴 팀({teamName(match.winnerTeam!, match.teamASide)})은 실제로 어느 진영이었나요?
            </legend>
            <div className="choice-row">
              {(["blue", "red", "unknown"] as const).map((value) => (
                <label key={value} className={side === value ? "choice chosen" : "choice"}>
                  <input
                    type="radio"
                    name="side"
                    checked={side === value}
                    onChange={() => setSide(value)}
                  />
                  <span>{value === "unknown" ? "기억나지 않음" : SIDE_LABEL[value]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <ErrorNote error={error} />
          <button
            type="button"
            className="primary wide"
            disabled={busy || side === null || side === winnerSide}
            onClick={() => void send("correct", { field: "side", winnerSide: side })}
          >
            {busy ? "저장 중" : "진영 저장"}
          </button>
        </Dialog>
      )}

      {editing === "playedAt" && (
        <Dialog title="경기 시각 수정" onClose={closeEdit}>
          <p className="note">
            경기 시각만 변경합니다. 승패와 명단은 그대로이고, 이 경기가 다른 날이나 다른 시즌의
            기록으로 옮겨질 수 있습니다.
          </p>
          <label>
            경기 시각
            <input
              type="datetime-local"
              value={playedInput}
              onChange={(e) => setPlayedInput(e.target.value)}
            />
          </label>
          <ErrorNote error={error} />
          <button
            type="button"
            className="primary wide"
            disabled={busy || zonedInputToUtc(playedInput, tz) === null}
            onClick={() => {
              // 입력값은 모임 시간대의 시각으로 해석한다.
              const playedAt = zonedInputToUtc(playedInput, tz);
              if (playedAt) void send("correct", { field: "playedAt", playedAt });
            }}
          >
            {busy ? "저장 중" : "시각 저장"}
          </button>
        </Dialog>
      )}

      {editing === "champions" && (
        <Dialog title="챔피언 기록" onClose={closeEdit}>
          <p className="note">승패와 통계는 그대로예요. 조회 링크에서도 보여요.</p>
          <ChampionFields
            match={match}
            nameOf={nameOf}
            history={snapshot.matches}
            value={championDraft}
            onChange={setChampionDraft}
          />
          <ErrorNote error={error} />
          <button
            type="button"
            className="primary wide"
            disabled={busy || sameChampions(championDraft, championsOf(match))}
            onClick={() => void send("champions", { champions: championDraft })}
          >
            {busy ? "저장 중" : "챔피언 저장"}
          </button>
        </Dialog>
      )}

      {editing === "positions" && (
        <Dialog title="포지션 수정" onClose={closeEdit}>
          {pending ? (
            <RotationQuestion busy={busy} onAnswer={(fix) => void send("correct", { ...pending, fixRotation: fix })} />
          ) : (
            <>
              <p className="note">
                같은 팀의 두 사람을 고르면 포지션을 맞바꿉니다. 승패는 그대로이고 라인별 기록이 다시
                계산됩니다.
              </p>
              {(["A", "B"] as const).map((team) => (
                <ul key={team} className="list">
                  {teamRoster(match, team).map((r) => (
                    <li key={r.participantId}>
                      <button
                        type="button"
                        className={picked.includes(r.participantId) ? "list-row selected" : "list-row"}
                        aria-pressed={picked.includes(r.participantId)}
                        onClick={() =>
                          setPicked(
                            picked.includes(r.participantId)
                              ? picked.filter((id) => id !== r.participantId)
                              : [...picked, r.participantId].slice(-2),
                          )
                        }
                      >
                        {teamName(team, match.teamASide)} · {r.position ? POSITION_LABEL[r.position] : "-"} ·{" "}
                        {nameOf(r.participantId)}
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
              {picked.length === 2 && !sameTeam && (
                <p className="note error">같은 팀의 두 사람을 골라 주세요.</p>
              )}
              <ErrorNote error={error} />
              <button
                type="button"
                className="primary wide"
                disabled={busy || !sameTeam}
                onClick={() => {
                  const [a, b] = picked.map((id) => match.roster.find((r) => r.participantId === id)!);
                  if (!a || !b || !a.position || !b.position) return;
                  const positions: { participantId: string; position: Position }[] = [
                    { participantId: a.participantId, position: b.position },
                    { participantId: b.participantId, position: a.position },
                  ];
                  void send("correct", { field: "positions", positions });
                }}
              >
                {busy ? "저장 중" : "포지션 맞바꾸기"}
              </button>
            </>
          )}
        </Dialog>
      )}

      {editing === "participant" && (
        <Dialog title="참가자 교체" onClose={closeEdit}>
          {pending ? (
            <RotationQuestion busy={busy} onAnswer={(fix) => void send("correct", { ...pending, fixRotation: fix })} />
          ) : outId === null ? (
            <>
              <p className="note">기록에서 뺄 사람을 고르세요.</p>
              <ul className="list">
                {match.roster.map((r) => (
                  <li key={r.participantId}>
                    <button type="button" className="list-row" onClick={() => setOutId(r.participantId)}>
                      {teamName(r.team, match.teamASide)} · {r.position ? POSITION_LABEL[r.position] : "-"} ·{" "}
                      {nameOf(r.participantId)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className="note">
                {nameOf(outId)}의 기록에서 이 경기가 빠지고, 고른 사람의 기록에 추가됩니다. 두 사람의
                배치 판수도 함께 바뀝니다. 나머지 9명은 그대로입니다.
              </p>
              {inCandidates.length === 0 ? (
                <p className="hint">바꿔 넣을 수 있는 참가자가 없어요.</p>
              ) : (
                <ul className="list">
                  {inCandidates.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="list-row"
                        disabled={busy}
                        onClick={() =>
                          void send("correct", {
                            field: "participant",
                            outParticipantId: outId,
                            inParticipantId: p.id,
                          })
                        }
                      >
                        {p.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <ErrorNote error={error} />
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}

function RotationQuestion(props: { busy: boolean; onAnswer: (fix: boolean) => void }) {
  return (
    <>
      <p>
        이 정정으로 이 경기의 서포터가 바뀝니다. 서포터 횟수 기록도 함께 고칠까요?
      </p>
      <div className="button-row">
        <button type="button" className="primary" disabled={props.busy} onClick={() => props.onAnswer(true)}>
          함께 고치기
        </button>
        <button type="button" className="secondary" disabled={props.busy} onClick={() => props.onAnswer(false)}>
          횟수 기록은 그대로
        </button>
      </div>
    </>
  );
}
