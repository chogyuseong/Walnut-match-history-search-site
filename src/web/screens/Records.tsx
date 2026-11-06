import { Fragment, useMemo, useState } from "react";
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
import {
  matchesInScope,
  PLACEMENT_GAMES,
  scopeLabel as scopeLabelOf,
  type Scope,
} from "../../shared/stats";
import {
  POSITIONS,
  sideOfTeam,
  type MatchView,
  type Position,
  type Side,
  type Snapshot,
} from "../../shared/types";
import { ApiFailure, mutate, newRequestId } from "../api";
import {
  formatDate,
  formatTime,
  nameMap,
  POSITION_LABEL,
  objectParticle,
  rateTier,
  resultLine,
  SIDE_LABEL,
  standingsOf,
  STATE_LABEL,
  teamName,
  teamRoster,
} from "../format";
import { MatchCard } from "../matchCard";
import { MatchMemoSection } from "../memoField";
import { MatchSeriesSection, SeriesListSection, useSeriesBadges } from "../seriesPanel";
import { drawMatchImage, fileDate, ShareImageDialog } from "../shareImage";
import { BackLink, Dialog, ErrorNote, FormDots, KpiStrip, MatchTeams, ScopePicker, StandingNote } from "../ui";
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

/**
 * 경기 거르기: 사람(여러 명이면 모두 함께 뛴 경기), 첫 번째 사람의 라인·승패, 이긴 팀의 진영.
 * 라인·승패는 사람을 고른 뒤에만 고를 수 있다.
 */
function MatchFilterBar(props: {
  scoped: readonly MatchView[];
  filter: MatchFilter;
  onChange: (filter: MatchFilter) => void;
  nameOf: (id: string) => string;
}) {
  const { filter, onChange, nameOf } = props;
  const candidates = useMemo(() => {
    const ids = new Set<string>();
    for (const m of props.scoped) for (const r of m.roster) ids.add(r.participantId);
    return [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b), "ko"));
  }, [props.scoped, nameOf]);
  const hasPerson = filter.people.length > 0;
  const anchorName = hasPerson ? nameOf(filter.people[0]!) : "";

  return (
    <div className="match-filter" role="group" aria-label="경기 거르기">
      <div className="filter-row">
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
      </div>
      {hasPerson && (
        <>
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
        </>
      )}
    </div>
  );
}

/**
 * 화면 6 — 기록. 운영자와 조회자가 같은 화면을 본다.
 * 경기는 카드 목록(양 팀 명단), 범위 선택과 거르기는 목록 바로 위에 둔다.
 */
export function Records(props: {
  snapshot: Snapshot;
  openMatch: (id: string) => void;
  openPerson: (id: string) => void;
  openGraphs: () => void;
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
  // 최근 세션에 경기가 없으면 "오늘"이 비어 보이므로 전체로 연다.
  const [scope, setScope] = useState<Scope>(() =>
    matchesInScope(snapshot, { kind: "today" }).length > 0 ? { kind: "today" } : { kind: "all" },
  );
  const [shown, setShown] = useState(PAGE);
  const [query, setQuery] = useState("");
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
  const ranking = useMemo(
    () => rankAndSearch(lineRecords, placement, nameOf, sort, query),
    [lineRecords, placement, nameOf, sort, query],
  );
  const records = ranking.shown;
  // 묶음(누적 50경기 이상 · 배치 완료 · 배치 진행 중)이 둘 이상이고 검색하지 않을 때만 묶음 소제목을 보인다.
  const groupHeads =
    query.trim() === "" && new Set(records.map((r) => rankingGroup(placement, r.participantId))).size > 1;
  // 변경 내역: 정정·제외·복구와, 합치기(한 번에 한 줄로 묶어 서버가 보냄).
  const changeLog = snapshot.revisions.filter((r) =>
    ["correction", "exclude", "restore", "merge", "merge_undo"].includes(r.kind),
  );

  return (
    <div className="screen cols">
      <header className="screen-head">
        <h1>기록</h1>
        {props.openBackfill && (
          <button type="button" className="secondary" onClick={props.openBackfill}>
            지난 경기 입력
          </button>
        )}
        <button type="button" className="secondary" onClick={props.openGraphs}>
          그래프 분석
        </button>
      </header>

      <KpiStrip snapshot={snapshot} />

      <ScopePicker
        snapshot={snapshot}
        scope={scope}
        onChange={(next) => {
          setScope(next);
          setShown(PAGE);
        }}
      />
      {season && (
        <p className="hint">
          {season.name}: {season.startsOn} ~ {season.endsOn}
        </p>
      )}
      {props.openSeason && (scope.kind === "season" || scope.kind === "year") && (
        <p className="hint">
          <button type="button" className="link" onClick={() => props.openSeason!(scope)}>
            {scopeLabel} 요약과 시상 보기
          </button>
        </p>
      )}

      <section aria-label="경기 목록">
        <h2>
          {scope.kind === "today" ? "오늘의 결과" : `${scopeLabel} 경기`} · {confirmed}경기 확정
          {awaiting > 0 ? ` · 결과 미입력 ${awaiting}` : ""}
          {excluded > 0 ? ` · 전적 제외 ${excluded}` : ""}
        </h2>
        {ordered.length > 0 && (
          <MatchFilterBar
            scoped={scoped}
            filter={filter}
            onChange={setFilter}
            nameOf={nameOf}
          />
        )}
        {filtering && (
          <p className="filter-summary" role="status">
            <span>
              <strong>{filterText(filter, nameOf)}</strong> · {filtered.length}경기
              {anchor && anchorTally && anchorTally.games > 0
                ? ` · ${nameOf(anchor)} ${anchorTally.wins}승 ${anchorTally.games - anchorTally.wins}패`
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
      </section>

      <section aria-label="소환사 랭킹">
        <h2>
          소환사 랭킹 ({scopeLabel}
          {line ? ` · ${POSITION_LABEL[line]}` : ""})
        </h2>
        <div className="rank-controls">
          <div className="segmented" role="group" aria-label="랭킹 정렬">
            {(Object.keys(RANKING_SORT_LABEL) as RankingSort[]).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={sort === key}
                onClick={() => setSort(key)}
              >
                {RANKING_SORT_LABEL[key]}
              </button>
            ))}
          </div>
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
        </div>
        <input
          type="search"
          aria-label="이름 검색"
          placeholder="이름 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <p className="hint rank-rule">누적 {RANKING_VETERAN_GAMES}경기 이상인 사람을 먼저 보여줘요.</p>
        {scope.kind !== "all" && query.trim() !== "" && records.length === 0 && (
          <p className="hint">
            <button type="button" className="link" onClick={() => setScope({ kind: "all" })}>
              전체 범위에서 찾기
            </button>
          </p>
        )}
        {ranking.ranked.length === 0 ? (
          <p className="hint">
            {line
              ? `이 범위에는 ${POSITION_LABEL[line]}(으)로 뛴 확정 경기가 없어요.`
              : "이 범위에는 확정된 경기가 없어요."}
          </p>
        ) : records.length === 0 ? (
          <p className="hint">일치하는 이름이 없어요.</p>
        ) : (
          <ul className="list">
            {records.map((r, i) => {
              const form = forms.get(r.participantId);
              const streak = form?.currentStreak ?? 0;
              const rate = Math.round((r.wins / r.games) * 100);
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
                    <button
                      type="button"
                      className="list-row rank-row"
                      onClick={() => props.openPerson(r.participantId)}
                    >
                      <span className="rank-main">
                        <span className="rank-name">
                          <span className={r.rank <= 3 ? "rank top" : "rank"}>{r.rank}</span>{" "}
                          <span className="rank-person">{r.name}</span>
                        </span>
                        <span className="form-line">
                          <FormDots results={recentResults(form)} />
                          {Math.abs(streak) >= 2 && (
                            <span className={streak > 0 ? "streak win" : "streak loss"}>
                              {streakText(streak)}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="stat">
                        <span className={rateTier(r.wins, r.games)}>{rate}%</span> · {r.wins}승 {r.losses}패 (
                        {r.games}경기)
                        <br />
                        <span className="hint">
                          <StandingNote standing={placement.get(r.participantId)} />
                        </span>
                      </span>
                    </button>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        )}
        <p className="hint">
          순서: 누적 {RANKING_VETERAN_GAMES}경기 이상 → 배치 완료(누적 {PLACEMENT_GAMES}경기 이상) → 배치 진행 중, 묶음 안에서는 {RANKING_SORT_LABEL[sort]}
          {sort === "rate" ? " → 경기 수 → 이름" : sort === "games" ? " → 승률 → 이름" : " → 승률 → 경기 수 → 이름"}.
          이름을 검색하면 일치하는 순으로 보여주고 순위 숫자는 바뀌지 않습니다. 승·패 칸은 최근 경기가
          왼쪽이며, 2경기 이상 이어지면 연승·연패를 적습니다. 결과 미입력·제외 경기는 세지 않습니다.
          {line && noPosition > 0
            ? ` 포지션 기록이 없는 ${noPosition}경기는 라인별 순위에서 빠집니다.`
            : ""}
        </p>
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
    </div>
  );
}

type Editing = null | "winner" | "side" | "positions" | "participant" | "playedAt";

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
  const [imageOpen, setImageOpen] = useState(false);

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
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${snapshot.group.id}/matches/${match!.id}/${action}`, {
        requestId: newRequestId(),
        baseMatchVersion: match!.version,
        ...body,
      });
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

      <MatchTeams match={match} nameOf={nameOf} />

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
                  // 입력 칸은 이 기기의 현지 시각으로 채운다.
                  const d = new Date(match.playedAt);
                  const pad = (v: number) => String(v).padStart(2, "0");
                  setPlayedInput(
                    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
                  );
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
        </ul>
      )}

      {operator && match.state === "awaiting_result" && (
        <button type="button" className="primary wide" onClick={() => setResultOpen(true)}>
          결과 입력
        </button>
      )}

      {operator && (match.state === "confirmed" || match.state === "awaiting_result") && (
        <details>
          <summary>더보기</summary>
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
      {editing === null && <ErrorNote error={error} />}

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
                {REVISION_LABEL[r.kind] ?? r.kind}
                {Object.keys(r.changes).length > 0 && r.kind === "correction"
                  ? ` · ${Object.keys(r.changes)
                      .map((k) => changeText(k, nameOf, match))
                      .join(", ")}`
                  : ""}
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
            {busy ? "저장 중" : "변경"}
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
            disabled={busy || playedInput === "" || Number.isNaN(Date.parse(playedInput))}
            onClick={() =>
              void send("correct", {
                field: "playedAt",
                playedAt: new Date(playedInput).toISOString(),
              })
            }
          >
            {busy ? "저장 중" : "변경"}
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
                <p className="note warn">같은 팀의 두 사람을 골라 주세요.</p>
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
