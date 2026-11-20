// 그래프 분석 화면. 범위·라인·플레이어 고르기, 요약(또는 고른 플레이어 묶음), 분석 코멘트, 이야기 띠, 섞기 공정성,
// 보기 여섯 개(개인별 승률·플레이어 × 라인·라인별 승률·순위 변동·라인 모양·활동)를 그린다. 운영자(App.tsx)와
// 모임 링크(Viewer.tsx)가 같이 쓴다. 부품은 graphBars·graphProfile·graphCommentary·graphFairness·graphFigures에 있다.
import { RANKING_GROUP_LABEL, RANKING_VETERAN_GAMES, rankingGroup, sortRankingBy } from "../../shared/insights";
import { useMemo, useState, type ReactNode } from "react";
import { isCounted, localDate, matchesInScope, matchYears, personRecordsByLine, placementGamesOf, scopeLabel as scopeLabelOf, playerLineMatrix, ratePercent, sideTotals, SMALL_SAMPLE, type PersonRecord } from "../../shared/stats";
import { POSITIONS, type Position, type Snapshot } from "../../shared/types";
import { nameMap, percentText, POSITION_LABEL, standingsOf } from "../format";
import { BackLink, InfoTip, ScopeBasis, scopeFromValue, scopeSuffix, useRouteScope, scopeValue, ScreenHead } from "../screenKit";
import { useExpectations } from "../matchCard";
import { fairnessReport } from "../../shared/upset";
import { attendanceReport } from "../../shared/attendance";
import { computeRatings, ratingOptionsOf } from "../../shared/rating";
import { groupCommentary } from "../../shared/groupCommentary";
import {
  activityCalendar,
  calendarRange,
  CALENDAR_WEEKS,
  dailyCounts,
  groupLineTotals,
  lineShape,
  raceDrawable,
  RACE_MIN_GAMES,
  rankRace,
  storyCards,
  WEEKDAY_LABEL,
  type ShapeMode,
} from "../../shared/graphs";
import {
  ActivityCalendarView,
  CalendarLegend,
  LineShapeChart,
  RankRaceChart,
  RACE_COLORED,
  StoryStrip,
  type ShapeEntry,
} from "./graphFigures";
import { MatrixTable, RateBar, standingText, StepLegend } from "./graphBars";
import { CommentaryCard } from "./graphCommentary";
import { FairnessSection } from "./graphFairness";
import { PlayerProfile } from "./graphProfile";

/** 보기 전환: 한 번에 하나만 전체 폭으로 그린다(2026-11-08 재구성). */
type View = "people" | "matrix" | "lines" | "race" | "shape" | "activity";

const VIEW_LABEL: Record<View, string> = {
  people: "개인별 승률",
  matrix: "플레이어 × 라인",
  lines: "라인별 승률",
  race: "순위 변동",
  shape: "라인 모양",
  activity: "활동",
};

/** 이 범위·라인에서 자료가 적은(SMALL_SAMPLE 미만) 사람을 맨 아래로 보낸다(제자리 정렬, 안정 정렬이라 순서 유지). */
function withSample(rows: PersonRecord[]): PersonRecord[] {
  return rows.sort((a, b) => Number(a.games < SMALL_SAMPLE) - Number(b.games < SMALL_SAMPLE));
}

/** 개인별 승률 묶음. 0~2는 랭킹 묶음(누적 기준), 3은 이 범위·라인에서 5경기 미만(자료 적음). */
type BarGroup = 0 | 1 | 2 | 3;

const BAR_GROUP_LABEL: Record<BarGroup, string> = {
  ...RANKING_GROUP_LABEL,
  3: `자료 적음(${SMALL_SAMPLE}경기 미만)`,
};

/**
 * 그래프 분석. 기존 서비스의 네 가지를 옮겼다:
 * 개인별 승률, 라인별 승률, 진영별 누적 승률, 플레이어 × 라인.
 * 위에서 아래로: 도구 띠(범위·라인·플레이어 + 요약 글) → 요약 타일 4칸(진영 승률 포함) →
 * 보기 전환(개인별 · 플레이어 × 라인 · 라인별) → 고른 보기 하나를 전체 폭으로(2026-11-08 재구성).
 */
export function Graphs(props: {
  snapshot: Snapshot;
  /** id 뒤에 주소 꼬리("?scope=…")를 붙여 넘길 수 있다. 부르는 쪽은 그대로 경로에 붙인다(App.tsx·Viewer.tsx). */
  openPerson: (id: string) => void;
  back: () => void;
  /** 주소에 담긴 고른 플레이어(#/graphs/ID). choosePlayer와 함께 주면 고르기가 주소를 따른다. */
  player?: string;
  /** 플레이어 고르기·해제(""). 주지 않으면 화면 안에서만 기억한다. */
  choosePlayer?: (id: string) => void;
  /** 확정 경기가 하나도 없을 때 안내 아래에 둘 행동 하나(운영자: 팀 짜기). 모임 링크는 비운다. */
  emptyAction?: ReactNode;
  /** 분석 코멘트 "근거 경기"의 경기 줄을 누르면 그 경기 상세로 간다(운영자 #/m/ID, 모임 링크 …/d/ID). */
  openMatch: (id: string) => void;
}) {
  const { snapshot } = props;
  const timeZone = snapshot.group.timezone;
  const placementGames = placementGamesOf(snapshot.group.settings);
  const [line, setLine] = useState<Position | "">("");
  const [localPlayer, setLocalPlayer] = useState("");
  const [view, setView] = useState<View>("people");
  const [shapeMode, setShapeMode] = useState<ShapeMode>("rate");
  const [compareId, setCompareId] = useState("");
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const expectations = useExpectations(snapshot);
  // 고른 플레이어: 주소(#/graphs/ID)에 두어 개인 통계로 갔다 돌아와도 남는다. 없는 사람 ID면 고르지 않은 것으로 본다.
  const wanted = props.choosePlayer ? (props.player ?? "") : localPlayer;
  const playerId = snapshot.participants.some((p) => p.id === wanted) ? wanted : "";
  // 범위는 주소(?scope=)에 남긴다. 플레이어를 바꾸면(#/graphs/ID) 새 주소에도 다시 적고(playerId를 화면 열쇠로 넘김),
  // 이름을 눌러 개인 통계로 갈 때 같은 기간으로 연다(openPersonInScope).
  const [scope, setScope] = useRouteScope(snapshot, playerId);
  const openPersonInScope = (id: string) => props.openPerson(`${id}${scopeSuffix(scope)}`);
  const choosePlayer = (id: string) => (props.choosePlayer ? props.choosePlayer(id) : setLocalPlayer(id));

  const scopeLabel = scopeLabelOf(snapshot, scope);
  const years = useMemo(() => matchYears(snapshot), [snapshot]);
  const scoped = useMemo(() => matchesInScope(snapshot, scope), [snapshot, scope]);
  // 새 그림 계산(src/shared/graphs.ts). MMR은 범위와 무관한 누적, 참석·이야기는 이 범위.
  // 순위 변동·달력은 그 보기를 열었을 때만 계산한다(경기 수 × 사람 수라 다른 보기에서는 아깝다).
  const ratings = useMemo(() => computeRatings(snapshot.matches, ratingOptionsOf(snapshot.group.settings)), [snapshot]);
  const attendance = useMemo(() => attendanceReport(scoped, timeZone), [scoped, timeZone]);
  const stories = useMemo(
    () => storyCards({ scoped, expectations, attendance, ratings, nameOf, picked: playerId || null }),
    [scoped, expectations, attendance, ratings, nameOf, playerId],
  );
  // 분석 코멘트(모임 전체)는 고른 사람이 없을 때만 보인다. 순위 변동 계산이 들어 있어 그때만 구한다.
  const groupNotes = useMemo(
    () =>
      playerId === ""
        ? groupCommentary({ allMatches: snapshot.matches, scoped, nameOf, ratings, expectations, timeZone, placementGames })
        : null,
    [playerId, snapshot, scoped, nameOf, ratings, expectations, timeZone, placementGames],
  );
  const race = useMemo(
    () => (view === "race" ? rankRace(snapshot.matches, ratings, scoped, timeZone, placementGames) : null),
    [view, snapshot, ratings, scoped, timeZone, placementGames],
  );
  const calendar = useMemo(() => {
    if (view !== "activity" || scope.kind === "today") return null;
    const today = localDate(snapshot.serverTime, timeZone);
    let range: { start: string; end: string };
    if (scope.kind === "season") {
      const season = snapshot.seasons.find((s) => s.id === scope.seasonId);
      if (!season) return null;
      range = calendarRange({ kind: "season", startsOn: season.startsOn, endsOn: season.endsOn }, today);
    } else {
      range = calendarRange(scope, today);
    }
    return activityCalendar(dailyCounts(scoped, timeZone, playerId || null), range.start, range.end);
  }, [view, scope, snapshot, scoped, timeZone, playerId]);
  // 배치와 칭호는 범위와 무관하게 전체 누적 기준이다.
  const placement = useMemo(() => standingsOf(snapshot), [snapshot]);

  // 랭킹 화면과 같은 묶음 순서(2026-11-08): 누적 50경기 이상 → 배치 완료(50경기 미만) → 배치 진행 중, 그 안에서 승률순.
  // 배치를 마쳤어도 50경기 미만이면 50경기 이상인 사람보다 항상 아래에 선다.
  // 이 범위·라인에서 5경기 미만(색을 칠하지 않는 "자료 적음")인 사람은 묶음과 무관하게 맨 아래로(2026-11-08).
  // 라인별로 보면 누적이 많은 사람도 그 라인은 한두 경기라 100%·0%가 섞여 들어가 위에 서는 것을 막는다.
  const people = useMemo(
    () =>
      withSample(
        sortRankingBy([...personRecordsByLine(scoped, line === "" ? null : line).values()], placement, nameOf, "rate"),
      ),
    [scoped, line, placement, nameOf],
  );
  // 정렬된 목록을 묶음별로 나눈다. 정렬이 묶음 순서를 따르므로 같은 묶음은 이어져 있다.
  const groupOf = (r: PersonRecord): BarGroup =>
    r.games < SMALL_SAMPLE ? 3 : rankingGroup(placement, r.participantId);
  const peopleGroups: { group: BarGroup; rows: PersonRecord[] }[] = [];
  for (const r of people) {
    const g = groupOf(r);
    const last = peopleGroups[peopleGroups.length - 1];
    if (last && last.group === g) last.rows.push(r);
    else peopleGroups.push({ group: g, rows: [r] });
  }
  const matrix = useMemo(() => playerLineMatrix(scoped), [scoped]);
  const matrixRows = useMemo(
    () => withSample(sortRankingBy([...personRecordsByLine(scoped, null).values()], placement, nameOf, "rate")),
    [scoped, placement, nameOf],
  );
  // 표에서 색 칸(어느 라인이든 5경기 이상)이 하나도 없는 사람은 "자료 적음" 접힘으로 보낸다.
  const hasColoredCell = (id: string) => {
    const row = matrix.get(id) ?? {};
    return POSITIONS.some((p) => (row[p]?.games ?? 0) >= SMALL_SAMPLE);
  };
  const sides = useMemo(() => sideTotals(scoped), [scoped]);
  const blueRate = sides.known > 0 ? ratePercent(sides.blueWins, sides.known) : null;
  // 레드는 100 − 블루(시즌 요약과 같은 방식. 따로 반올림하면 합이 101%가 될 수 있다).
  const redRate = blueRate !== null ? 100 - blueRate : null;
  // 섞기 공정성(upset.ts): 판정은 경기 직전 팀 평균 MMR 차(누적, 모든 모임 같은 점수 기준), 세는 경기는 이 범위.
  const fairness = useMemo(() => fairnessReport(expectations, scoped), [expectations, scoped]);
  const fewCount = matrixRows.filter((r) => r.games < SMALL_SAMPLE).length;
  const playerLines = playerId === "" ? null : (matrix.get(playerId) ?? {});
  // 고른 사람이 이 범위에 기록이 없어도 목록에서 사라지지 않게 함께 둔다.
  const selectable = [...snapshot.participants]
    .filter((p) => p.id === playerId || matrixRows.some((r) => r.participantId === p.id))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const shapeEntries: ShapeEntry[] =
    playerId === ""
      ? [{ key: "all", label: "모임 전체", axes: lineShape(groupLineTotals(matrix), "games"), slot: 1 }]
      : [
          { key: playerId, label: nameOf(playerId), axes: lineShape(matrix.get(playerId) ?? {}, shapeMode), slot: 1 },
          ...(compareId !== "" && compareId !== playerId
            ? [{ key: compareId, label: nameOf(compareId), axes: lineShape(matrix.get(compareId) ?? {}, shapeMode), slot: 2 as const }]
            : []),
        ];

  // 모임에 확정 경기가 하나도 없으면 빈 그림·빈 칸 여러 개 대신 안내 하나와 행동 하나만 둔다(CLAUDE.md 8절).
  // 범위를 좁혀 비는 경우는 고르기 줄이 필요하므로 여기에 들지 않는다(누적 기준으로 판단).
  if (!snapshot.matches.some(isCounted)) {
    return (
      <div className="screen page-wide viz-root">
        <ScreenHead
          back={<BackLink label="← 기록" fallback={props.back} />}
          title="그래프 분석"
          desc="범위·플레이어를 골라 승률·라인·진영·편성 흐름을 봐요"
        />
        <div className="empty-state">
          <p>결과를 저장한 경기가 쌓이면 승률·라인·진영·섞기 공정성 분석이 보여요.</p>
          {props.emptyAction}
        </div>
      </div>
    );
  }

  return (
    <div className="screen cols viz-root">
      <ScreenHead
        back={<BackLink label="← 기록" fallback={props.back} />}
        title="그래프 분석"
        desc="범위·플레이어를 골라 승률·라인·진영·편성 흐름을 봐요"
      />

      {/* 도구 띠: 왼쪽 고르기, 오른쪽 요약 글과 도움말(2026-11-08 재구성. 예전에는 필터·요약·도움말이 따로 흩어져 있었다). */}
      <div className="graph-tools">
        <div className="filter-row" role="group" aria-label="필터">
          <label>
            범위
            <select
              aria-label="범위"
              value={scopeValue(scope)}
              onChange={(e) => setScope(scopeFromValue(e.target.value))}
            >
              <option value="all">전체</option>
              <option value="today">오늘</option>
              {snapshot.seasons.map((s) => (
                <option key={s.id} value={`season:${s.id}`}>
                  {s.name}
                </option>
              ))}
              {years.map((y) => (
                <option key={y} value={`year:${y}`}>
                  {y}년
                </option>
              ))}
            </select>
          </label>
          <label>
            라인
            <select aria-label="라인" value={line} onChange={(e) => setLine(e.target.value as Position | "")}>
              <option value="">전체 라인</option>
              {POSITIONS.map((p) => (
                <option key={p} value={p}>
                  {POSITION_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            플레이어
            <select
              aria-label="플레이어"
              value={playerId}
              // 플레이어를 고르면 위쪽이 그 사람 묶음으로 바뀐다(2026-11-09). 아래 보기는 그대로 두고 그 사람을 강조한다.
              onChange={(e) => choosePlayer(e.target.value)}
            >
              <option value="">선택 안 함</option>
              {selectable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {(playerId !== "" || fewCount > 0) && (
        <div className="graph-meta">
          <p className="hint">
            {/* 자료 적음 인원은 요약 칸(최대 셋)에서 이 줄로 내렸다. 참가자 수는 바로 아래 요약 칸에 크게 있으니
                되풀이하지 않고, 플레이어를 골라 요약 칸이 사라질 때만 이 줄에 적는다. 범위·확정 경기 수는 아래 기준 줄에 있다. */}
            {playerId !== "" && `참가자 ${matrixRows.length}명${fewCount > 0 ? " · " : ""}`}
            {/* 0명이면 알릴 것이 없어 뺀다. 필터 오른쪽에 "0명"만 떠 있으면 무언가 빠진 것처럼 보인다. */}
            {fewCount > 0 ? `자료 적음(${SMALL_SAMPLE}경기 미만) ${fewCount}명` : ""}
          </p>
        </div>
        )}
      </div>
      <ScopeBasis snapshot={snapshot} scope={scope} />

      {/* ─ 위쪽 묶음: 고른 플레이어가 있으면 그 사람 묶음, 없으면 모임 전체 요약 타일 ─ */}
      {playerId !== "" ? (
        <PlayerProfile
          snapshot={snapshot}
          participantId={playerId}
          scoped={scoped}
          scopeLabel={scopeLabel}
          ratings={ratings}
          expectations={expectations}
          attendance={attendance}
          matrix={matrix}
          standing={placement.get(playerId)}
          cumulative={placement}
          nameOf={nameOf}
          openPerson={() => openPersonInScope(playerId)}
          openMatch={props.openMatch}
          clear={() => choosePlayer("")}
        />
      ) : (
      <section className="graph-summary" aria-label="분석 요약">
        <h2 className="sr-only">요약</h2>
        {/* 확정 경기 수는 바로 위 기준 줄에 있어 타일로 되풀이하지 않는다. 남은 두 칸은 768px부터도 두 칸(.pair-tiles). */}
        <dl className="ps-tiles season-tiles pair-tiles">
          <div>
            <dt className="tile-label">참가자</dt>
            <dd className="season-stat">
              {matrixRows.length}
              <span className="season-unit">명</span>
            </dd>
          </div>
          <div>
            <dt className="tile-label">블루 : 레드 승률</dt>
            {blueRate !== null && redRate !== null ? (
              <dd className="season-stat season-sides">
                <span className="side-values">
                  <span className="blue">{blueRate}%</span>
                  <span className="side-colon"> : </span>
                  <span className="red">{redRate}%</span>
                </span>
                <span className="side-bar" aria-hidden="true">
                  <span className="side-blue" style={{ flexGrow: sides.blueWins }} />
                  <span className="side-red" style={{ flexGrow: sides.redWins }} />
                </span>
              </dd>
            ) : (
              <dd className="season-stat season-sides">
                <span className="side-values none">—</span>
                <span className="tile-sub">진영 기록 없음</span>
              </dd>
            )}
          </div>
        </dl>
        {/* 예전 "진영별 누적 승률" 카드의 내용: 진영마다 전적 글 한 줄과 미상 안내. */}
        {/* 글을 span 하나로 묶는다. i 버튼이 붙은 문단은 flex 줄이 되는데(styles.css .info-tip), 묶지 않으면
            " · " 같은 글자 조각이 따로 놓이며 앞뒤 빈칸이 사라진다. */}
        <p className="hint">
          <span className="tip-text">
            {sides.known === 0 ? (
              "진영을 아는 경기가 없어요."
            ) : (
              <>
                <span className="nowrap">블루 {percentText(sides.blueWins, sides.known)} · {sides.blueWins}승 {sides.known - sides.blueWins}패 ({sides.known}경기)</span>
                {" · "}
                <span className="nowrap">레드 {percentText(sides.redWins, sides.known)} · {sides.redWins}승 {sides.known - sides.redWins}패 ({sides.known}경기)</span>
              </>
            )}
            {sides.unknown > 0 && (
              <>
                {" · "}
                <span className="nowrap">진영 미상 {sides.unknown}경기는 제외했어요.</span>
              </>
            )}
          </span>
          <InfoTip label="진영 승률">
            진영 승률은 결과를 저장할 때 확인한 실제 진영 기준이고, 진영 미상 경기는 빼요.
          </InfoTip>
        </p>
      </section>
      )}
      {groupNotes && <CommentaryCard notes={groupNotes} snapshot={snapshot} openMatch={props.openMatch} />}

      {/* ─ 이야기 띠: 범위 안 유효 경기 5개부터. 카드를 누르면 그 사람을 고른다 ─ */}
      <StoryStrip cards={stories} picked={playerId} onPick={choosePlayer} />

      {/* ─ 섞기 공정성: 늘 모임 전체(고른 사람과 무관) ─ */}
      <FairnessSection fairness={fairness} />

      {/* ─ 보기 전환: 아래 보기 하나만 전체 폭으로. 고른 사람은 각 보기에서 강조만 한다 ─ */}
      <div className="segmented graph-views" role="group" aria-label="분석 보기">
        {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
          <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}>
            {VIEW_LABEL[v]}
          </button>
        ))}
      </div>

      {view === "people" && (
        <section className="chart-card full" aria-label="개인별 승률">
          <h2>
            개인별 승률{" "}
            <InfoTip label="개인별 승률 순서">
              개인별 승률 순서는 누적 {RANKING_VETERAN_GAMES}경기 이상 → 배치 완료({placementGames}경기 이상) → 배치 진행
              중이고, 그 안에서 승률순이에요. 보는 범위·라인에서 {SMALL_SAMPLE}경기 미만인 사람은 &lsquo;자료 적음&rsquo;으로
              맨 아래에 둬요. 배치와 칭호는 범위와 관계없이 누적 기준이에요.
            </InfoTip>
          </h2>
          <p className="hint">
            범위: {scopeLabel} · 라인: {line === "" ? "전체 라인" : POSITION_LABEL[line]} · 묶음 안에서 승률순 · 칭호는 누적
          </p>
          <StepLegend />
          {people.length === 0 ? (
            <p className="hint">이 조건에는 기록이 없어요.</p>
          ) : (
            peopleGroups.map(({ group, rows }) => (
              <div key={group} className="bar-group">
                <h3 className="bar-group-label">
                  {BAR_GROUP_LABEL[group]}
                  <span className="bar-group-count"> · {rows.length}명</span>
                </h3>
                <ul className="bars people-bars">
                  {rows.map((r) => (
                    <li key={r.participantId}>
                      <RateBar
                        label={nameOf(r.participantId)}
                        note={standingText(placement.get(r.participantId))}
                        wins={r.wins}
                        games={r.games}
                        hued
                        picked={r.participantId === playerId}
                        onOpen={() => openPersonInScope(r.participantId)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>
      )}

      {view === "matrix" && (
        <section className="chart-card full" aria-label="플레이어 × 라인">
          <h2>플레이어 × 라인</h2>
          <p className="hint">
            범위: {scopeLabel} · 위 숫자는 승률, 아래 숫자는 경기 수 · — 는 기록 없음
          </p>
          <StepLegend />
          {matrixRows.length === 0 ? (
            <p className="hint">이 범위에는 기록이 없어요.</p>
          ) : (
            <>
              <MatrixTable
                rows={matrixRows.filter((r) => hasColoredCell(r.participantId))}
                matrix={matrix}
                nameOf={nameOf}
                playerId={playerId}
                openPerson={openPersonInScope}
              />
              {matrixRows.some((r) => !hasColoredCell(r.participantId)) && (
                <details className="matrix-few">
                  <summary>
                    어느 라인도 {SMALL_SAMPLE}경기 미만 · {matrixRows.filter((r) => !hasColoredCell(r.participantId)).length}명(자료
                    적음)
                  </summary>
                  <MatrixTable
                    rows={matrixRows.filter((r) => !hasColoredCell(r.participantId))}
                    matrix={matrix}
                    nameOf={nameOf}
                    playerId={playerId}
                    openPerson={openPersonInScope}
                  />
                </details>
              )}
            </>
          )}
        </section>
      )}

      {view === "lines" && (
        <section className="chart-card full line-first" aria-label="라인별 승률">
          <h2>
            라인별 승률{" "}
            <InfoTip label="라인별 승률">
              플레이어를 고르면 그 사람의 라인별 승률을 보여 줘요. 전체 플레이어를 합치면 각 경기마다 라인별로 1승·1패가
              생겨 항상 50%이므로 보여주지 않아요.
            </InfoTip>
          </h2>
          {playerLines === null ? (
            // 전체 플레이어를 합친 라인별 승률은 항상 50%라 그리지 않는다(까닭은 제목 옆 i 설명).
            <p className="hint">위 &lsquo;플레이어&rsquo;에서 한 사람을 고르면 그 사람의 라인별 승률을 보여 줘요.</p>
          ) : (
            <>
              <p className="hint">
                범위: {scopeLabel} · 플레이어: {nameOf(playerId)}
              </p>
              <ul className="bars">
                {POSITIONS.map((position) => {
                  const tally = playerLines[position];
                  return (
                    <li key={position}>
                      {tally ? (
                        <RateBar label={POSITION_LABEL[position]} wins={tally.wins} games={tally.games} hued />
                      ) : (
                        // 기록이 없어도 같은 높이의 빈 막대를 둔다(PC 5칸 가로 배치에서 줄이 깨지지 않게).
                        <RateBar label={POSITION_LABEL[position]} note="기록 없음" wins={0} games={0} />
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
      )}

      {/* ─ 보기: 순위 변동(MMR 순위, 누적 기준) ─ */}
      {view === "race" && race && (
        <section className="chart-card full" aria-label="순위 변동">
          <h2>순위 변동</h2>
          <p className="hint">
            범위: {scopeLabel} · MMR 순위(누적 기준) · {race.unit === "day" ? "모임 날" : "경기"}마다 · 배치({placementGames}경기)
            전에는 선이 없어요
          </p>
          {raceDrawable(race) ? (
            <>
              <RankRaceChart race={race} nameOf={nameOf} picked={playerId} />
              <p className="hint">
                마지막 상위 {RACE_COLORED}명은 색, 나머지는 회색{playerId !== "" ? ` · ${nameOf(playerId)} 님은 굵게` : ""}. 선을
                누르면 그 사람만 진하게 봐요.
              </p>
            </>
          ) : (
            <p className="hint">
              경기가 더 쌓이면 보여요(이 범위 {race.games}경기 · {RACE_MIN_GAMES}경기부터, 배치 마친 사람 2명부터).
            </p>
          )}
        </section>
      )}

      {/* ─ 보기: 라인 모양. 고른 사람이 없으면 모임 전체 경기 수 분포만(승률은 늘 50%라 뜻이 없다) ─ */}
      {view === "shape" && (
        <section className="chart-card full" aria-label="라인 모양">
          <h2>라인 모양</h2>
          {playerId === "" ? (
            <p className="hint">
              범위: {scopeLabel} · 모임 전체의 라인별 경기 수(가장 많은 라인이 끝). 모임 전체 승률은 늘 50%라 그리지 않아요.
              위 &lsquo;플레이어&rsquo;에서 한 사람을 고르면 그 사람의 모양을 봐요.
            </p>
          ) : (
            <>
              <div className="shape-tools">
                <div className="segmented" role="group" aria-label="라인 모양 값">
                  <button type="button" aria-pressed={shapeMode === "rate"} onClick={() => setShapeMode("rate")}>
                    승률
                  </button>
                  <button type="button" aria-pressed={shapeMode === "games"} onClick={() => setShapeMode("games")}>
                    경기 수
                  </button>
                </div>
                <label>
                  비교할 사람
                  <select aria-label="비교할 사람" value={compareId} onChange={(e) => setCompareId(e.target.value)}>
                    <option value="">없음</option>
                    {selectable
                      .filter((p) => p.id !== playerId)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <p className="hint">
                범위: {scopeLabel} ·{" "}
                {shapeMode === "rate"
                  ? `끝이 100%, 눈금은 33·67%. ${SMALL_SAMPLE}경기 미만 라인은 흐리게 안쪽으로 당겨요`
                  : "사람마다 가장 많이 뛴 라인이 끝"}
              </p>
            </>
          )}
          <LineShapeChart entries={shapeEntries} mode={playerId === "" ? "games" : shapeMode} />
        </section>
      )}

      {/* ─ 보기: 활동 달력. "오늘" 범위는 하루뿐이라 그리지 않는다 ─ */}
      {view === "activity" && (
        <section className="chart-card full" aria-label="활동">
          <h2>활동</h2>
          {scope.kind === "today" ? (
            <p className="hint">오늘 범위에서는 달력을 그리지 않아요. 범위를 전체·시즌·연도로 바꿔 보세요.</p>
          ) : calendar === null ? (
            <p className="hint">이 범위의 기간을 찾을 수 없어요.</p>
          ) : (
            <>
              <p className="hint">
                범위: {scopeLabel}
                {scope.kind === "all" ? ` · 최근 ${CALENDAR_WEEKS}주` : ""} · 칸 하나가 하루, 진할수록 경기가 많아요
                {playerId !== "" ? ` · ${nameOf(playerId)} 님이 나온 경기만` : ""}
              </p>
              <ActivityCalendarView calendar={calendar} who={playerId !== "" ? nameOf(playerId) : "모임"} />
              <CalendarLegend />
              <p className="hint">
                {calendar.activeDays === 0
                  ? "이 기간에는 경기가 없어요."
                  : `${playerId !== "" ? "참석한 날" : "모임 날"} ${calendar.activeDays}일 · 가장 바쁜 요일 ${
                      calendar.busiestWeekday !== null ? WEEKDAY_LABEL[calendar.busiestWeekday] : "—"
                    } · 하루 평균 ${calendar.avgPerDay.toFixed(1)}경기`}
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
