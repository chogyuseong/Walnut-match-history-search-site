import { cumulativeTrend, RANKING_GROUP_LABEL, RANKING_VETERAN_GAMES, rankingGroup, resultsOf, sortRankingBy, streakOf, streakText } from "../../shared/insights";
import { useMemo, useState, type ReactNode } from "react";
import { fractionPercent, isCounted, localDate, matchesInScope, matchYears, personRecordsByLine, placementGamesOf, scopeLabel as scopeLabelOf, playerLineMatrix, ratePercent, sideTotals, SMALL_SAMPLE, type Scope, type Tally, type PersonRecord } from "../../shared/stats";
import { POSITIONS, type Position, type Snapshot } from "../../shared/types";
import { heatClass, nameMap, rateTier, POSITION_LABEL, RATE_HEAT_COLD, RATE_HEAT_HOT, standingsOf, type ShownStanding } from "../format";
import {
  Meter,
  BackLink,
  FormDots,
  InfoTip,
  PosLabel,
  RateRing,
  RatingTierBadge,
  scopeFromValue,
  scopeValue,
  ScreenHead,
  TitleBadge,
  TrendLine,
} from "../screenKit";
import { useExpectations } from "../matchCard";
import { BALANCED_MARGIN, fairnessReport, FAIRNESS_GOOD, FAIRNESS_MIN_GAMES, FAIRNESS_OK, personUpsets, UPSET_THRESHOLD, LOPSIDED_MARGIN, fairnessVerdict, type FairnessVerdict } from "../../shared/upset";
import { attendanceReport } from "../../shared/attendance";
import { computeRatings, shownRating, ratingOptionsOf } from "../../shared/rating";
import { groupCommentary, playerCommentary, type Commentary } from "../../shared/commentary";
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
  ratingRank,
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

/** 막대 옆 짧은 표시: 배치 중이면 "배치 진행 중", 완료자는 칭호(누적 기준). */
function standingText(standing: ShownStanding | undefined): ReactNode {
  if (!standing?.done) return "배치 진행 중";
  return standing.title ? (
    <>
      <TitleBadge name={standing.title} grade={standing.grade} compact />
      (누적)
    </>
  ) : undefined;
}

function percent(wins: number, games: number): number {
  return games === 0 ? 0 : (wins / games) * 100;
}

/** 다른 화면과 같은 정수 승률(예전에는 소수 한 자리였다. 2026-11-08 통일). */
function percentText(wins: number, games: number): string {
  return `${ratePercent(wins, games)}%`;
}

/**
 * 승률 막대 한 줄. 0~100% 한 축이고 50% 위치에 기준선을 둔다.
 * 값은 글자로 함께 쓰고(색에만 의존하지 않음), 글자는 막대와 같은 승률 3단 색을 따른다.
 * series(승률) 막대만 3단 색을 따르고 5경기 미만은 속 빈 테두리 막대 + "자료 적음" 글자다. 진영 막대(blue·red)는 진영 색 그대로.
 */
function RateBar(props: {
  label: string;
  note?: ReactNode;
  wins: number;
  games: number;
  tone?: "series" | "blue" | "red";
  /** 위에서 고른 플레이어의 줄(강조). */
  picked?: boolean;
  onOpen?: () => void;
}) {
  const { wins, games } = props;
  const tone = props.tone ?? "series";
  const fill = tone !== "series" ? `tone-${tone}` : games < SMALL_SAMPLE ? "tone-muted" : `tone-series ${heatClass(wins, games)}`;
  const detail = `${props.label}: ${percentText(wins, games)} · ${wins}승 ${games - wins}패 (${games}경기)`;
  const body = (
    <>
      <span className="bar-head">
        <span className="name">
          {props.label}
          {props.note && <span className="bar-note"> · {props.note}</span>}
        </span>
        <span className="bar-value">
          {games === 0 ? (
            <span className="bar-empty">—</span>
          ) : (
            <>
              <strong className={tone === "series" ? rateTier(wins, games) : undefined}>
                {percentText(wins, games)}
              </strong>{" "}
              · {wins}승 {games - wins}패 ({games}경기)
            </>
          )}
          {tone === "series" && games > 0 && games < SMALL_SAMPLE && (
            <>
              {" "}
              <span className="tag" title={`${SMALL_SAMPLE}경기 미만은 승률에 색을 칠하지 않아요`}>
                자료 적음
              </span>
            </>
          )}
        </span>
      </span>
      <span className="bar-track" aria-hidden="true">
        <span
          className={`bar-fill ${fill}`}
          style={{ width: `${percent(wins, games)}%` }}
        />
        <span className="bar-mid" />
      </span>
    </>
  );
  const rowClass = props.picked ? "bar-row picked" : "bar-row";
  return props.onOpen ? (
    <button type="button" className={rowClass} title={detail} onClick={props.onOpen}>
      {body}
    </button>
  ) : (
    <div className={rowClass} title={detail}>
      {body}
    </div>
  );
}

/** 표 칸의 승률 글자 색: 막대와 같은 3단(heatClass). 5경기 미만은 색을 입히지 않는다. */
function cellBand(tally: Tally): string {
  return heatClass(tally.wins, tally.games) || "band-none";
}

/** 보기 전환: 한 번에 하나만 전체 폭으로 그린다(2026-11-08 재구성). */
type View = "people" | "matrix" | "lines" | "race" | "shape" | "activity";

// ─ 섞기 공정성(모임 전체) 묶음의 화면 상수 ─
/**
 * 판정 한 줄 문구. 색은 styles.css .fair-good/.fair-ok/.fair-poor. 구간을 숫자로만 쓴다(2026-11-10 F5:
 * "섞기가 공정했어요"는 예상 승률이 MMR로 낸 추정이라는 점을 빼고 말한다).
 */
const FAIR_VERDICT_TEXT: Record<FairnessVerdict, string> = {
  good: `균형 경기 ${fractionPercent(FAIRNESS_GOOD)}% 이상`,
  ok: `균형 경기 ${fractionPercent(FAIRNESS_OK)}~${fractionPercent(FAIRNESS_GOOD) - 1}%`,
  poor: `균형 경기 ${fractionPercent(FAIRNESS_OK)}% 미만`,
};
const FAIR_SEG_LABEL = { balanced: "균형", slight: "조금 치우침", lopsided: "많이 치우침" } as const;
/** 분포 띠 구간 안에 경기 수를 쓰는 최소 비율(이보다 좁으면 숫자가 넘친다). */
const FAIR_SEG_LABEL_MIN = 0.12;
/** 평균 치우침 미터가 가득 차는 값(25%p). 실제 모임은 보통 3~12%p라 눈금이 너무 짧아지지 않게 잡았다. */
const FAIR_DEVIATION_FULL = 0.25;

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
  openPerson: (id: string) => void;
  back: () => void;
  /** 주소에 담긴 고른 플레이어(#/graphs/ID). choosePlayer와 함께 주면 고르기가 주소를 따른다. */
  player?: string;
  /** 플레이어 고르기·해제(""). 주지 않으면 화면 안에서만 기억한다. */
  choosePlayer?: (id: string) => void;
  /** 확정 경기가 하나도 없을 때 안내 아래에 둘 행동 하나(운영자: 팀 짜기). 조회 링크는 비운다. */
  emptyAction?: ReactNode;
}) {
  const { snapshot } = props;
  const timeZone = snapshot.group.timezone;
  const placementGames = placementGamesOf(snapshot.group.settings);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
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
  const counted = useMemo(() => scoped.filter((m) => m.state === "confirmed").length, [scoped]);
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
  // 섞기 공정성(upset.ts): 예상은 누적 MMR, 세는 경기는 이 범위.
  const fairness = useMemo(() => fairnessReport(expectations, scoped), [expectations, scoped]);
  const balancedLow = fractionPercent(0.5 - BALANCED_MARGIN);
  const balancedHigh = fractionPercent(0.5 + BALANCED_MARGIN);
  const lopsidedHigh = fractionPercent(0.5 + LOPSIDED_MARGIN);
  const verdict = fairnessVerdict(fairness);
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
          desc="범위·플레이어를 골라 승률·라인·진영·편성 흐름을 봅니다"
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
        desc="범위·플레이어를 골라 승률·라인·진영·편성 흐름을 봅니다"
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
        <div className="graph-meta">
          <p className="hint">
            {/* 자료 적음 인원은 요약 칸(최대 셋)에서 이 줄로 내렸다. */}
            {scopeLabel} · 확정 {counted}경기 · 참가자 {matrixRows.length}명 · 자료 적음({SMALL_SAMPLE}경기 미만) {fewCount}명
          </p>
        </div>
      </div>

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
          openPerson={() => props.openPerson(playerId)}
          clear={() => choosePlayer("")}
        />
      ) : (
      <section className="graph-summary" aria-label="분석 요약">
        <h2 className="sr-only">요약</h2>
        <dl className="ps-tiles season-tiles">
          <div>
            <dt className="tile-label">확정 경기</dt>
            <dd className="season-stat">
              {counted}
              <span className="season-unit">경기</span>
            </dd>
          </div>
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
                <span className="nowrap">진영 미상 {sides.unknown}경기는 제외했습니다.</span>
              </>
            )}
          </span>
          <InfoTip label="진영 승률">
            진영 승률은 결과를 저장할 때 확인한 실제 진영 기준이고, 진영 미상 경기는 뺍니다.
          </InfoTip>
        </p>
      </section>
      )}
      {groupNotes && <CommentaryCard notes={groupNotes} />}

      {/* ─ 이야기 띠: 범위 안 유효 경기 5개부터. 카드를 누르면 그 사람을 고른다 ─ */}
      <StoryStrip cards={stories} picked={playerId} onPick={choosePlayer} />

      {/* ─ 섞기 공정성: 늘 모임 전체(고른 사람과 무관) ─ */}
      <section className="graph-summary" aria-label="섞기 공정성(모임 전체)">
        <h2>
          섞기 공정성(모임 전체){" "}
          <InfoTip label="섞기 공정성">
            섞기 공정성은 경기 직전 팀원 MMR 평균으로 구한 예상 승률로 봅니다. 열 명 모두 배치 중인 경기는 예상이 의미가
            적어 뺍니다. 균형 경기는 예상이 {balancedLow}~{balancedHigh}%였던 경기, 평균 치우침은 예상이 50%에서 벗어난
            정도의 평균입니다.
          </InfoTip>
        </h2>
        {fairness.games < FAIRNESS_MIN_GAMES ? (
          <p className="hint">경기가 더 쌓이면 보여요(판정할 수 있는 경기 {fairness.games}/{FAIRNESS_MIN_GAMES}).</p>
        ) : (
          <>
            {/* 머리: 큰 숫자(균형 경기 비율) + 한 줄 판정. 색은 fairnessVerdict(good·ok·poor)를 따른다. */}
            <div className={`fair-head fair-${verdict}`}>
              <div className="fair-big">
                <span className="fair-pct">
                  {ratePercent(fairness.balanced, fairness.games)}
                  <span className="season-unit">%</span>
                </span>
                <span className="fair-big-label">균형 경기</span>
              </div>
              <div className="fair-verdict">
                <strong>{FAIR_VERDICT_TEXT[verdict]}</strong>
                <span className="hint">
                  판정한 {fairness.games}경기 중 {fairness.balanced}경기가 예상 {balancedLow}~{balancedHigh}%였어요.
                </span>
              </div>
            </div>
            {/* 분포 띠: 균형 / 조금 치우침 / 많이 치우침 세 구간을 경기 수 비율로. 0인 구간은 그리지 않는다. */}
            <div
              className="fair-dist"
              role="img"
              aria-label={`균형 ${fairness.balanced}경기, 조금 치우침 ${fairness.slight}경기, 많이 치우침 ${fairness.lopsided}경기`}
            >
              {(
                [
                  ["balanced", fairness.balanced],
                  ["slight", fairness.slight],
                  ["lopsided", fairness.lopsided],
                ] as const
              ).map(([kind, n]) =>
                n > 0 ? (
                  <span
                    key={kind}
                    className={`fair-seg fair-seg-${kind}`}
                    style={{ flexGrow: n }}
                    title={`${FAIR_SEG_LABEL[kind]} ${n}경기`}
                  >
                    {n / fairness.games >= FAIR_SEG_LABEL_MIN && <span>{n}</span>}
                  </span>
                ) : null,
              )}
            </div>
            <ul className="fair-legend" aria-hidden="true">
              <li>
                <i className="fair-seg-balanced" />
                균형 {balancedLow}~{balancedHigh}%
              </li>
              <li>
                <i className="fair-seg-slight" />
                조금 치우침 ~{lopsidedHigh}%
              </li>
              <li>
                <i className="fair-seg-lopsided" />
                많이 치우침
              </li>
            </ul>
            {/* 보조 타일 3칸: 미터로 크기를 보이게 한다. 평균 치우침은 FAIR_DEVIATION_FULL(25%p)을 가득으로 본다. */}
            <dl className="ps-tiles season-tiles fair-tiles">
              <div>
                <dt className="tile-label">평균 치우침</dt>
                <dd className="season-stat">
                  {fractionPercent(fairness.avgDeviation)}
                  <span className="season-unit">%p</span>
                </dd>
                <Meter value={fairness.avgDeviation / FAIR_DEVIATION_FULL} tone="share" small />
              </div>
              <div>
                <dt className="tile-label">예상 우세 팀 승률</dt>
                <dd className="season-stat">
                  {fairness.favoriteGames > 0 ? ratePercent(fairness.favoriteWins, fairness.favoriteGames) : "—"}
                  {fairness.favoriteGames > 0 && <span className="season-unit">%</span>}
                </dd>
                {fairness.favoriteGames > 0 && (
                  <Meter value={fairness.favoriteWins / fairness.favoriteGames} tone="share" mid small />
                )}
              </div>
              <div>
                <dt className="tile-label">이변 경기</dt>
                <dd className="season-stat">
                  {fairness.upsets}
                  <span className="season-unit">경기</span>
                </dd>
                <Meter value={fairness.upsets / fairness.games} tone="share" small />
              </div>
            </dl>
            <p className="hint">
              경기 전 예상 승률(누적 MMR로 낸 추정) 기준. 예상이 50%에 가까운 경기는 두 팀 MMR 평균이 비슷했던 경기예요.
            </p>
          </>
        )}
      </section>

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
              중이고, 그 안에서 승률순입니다. 보는 범위·라인에서 {SMALL_SAMPLE}경기 미만인 사람은 &lsquo;자료 적음&rsquo;으로
              맨 아래에 둡니다. 배치와 칭호는 범위와 관계없이 누적 기준입니다.
            </InfoTip>
          </h2>
          <p className="hint">
            범위: {scopeLabel} · 라인: {line === "" ? "전체 라인" : POSITION_LABEL[line]} · 묶음 안에서 승률순
          </p>
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
                        picked={r.participantId === playerId}
                        onOpen={() => props.openPerson(r.participantId)}
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
          <HeatLegend />
          {matrixRows.length === 0 ? (
            <p className="hint">이 범위에는 기록이 없어요.</p>
          ) : (
            <>
              <MatrixTable
                rows={matrixRows.filter((r) => hasColoredCell(r.participantId))}
                matrix={matrix}
                nameOf={nameOf}
                playerId={playerId}
                openPerson={props.openPerson}
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
                    openPerson={props.openPerson}
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
              플레이어를 고르면 그 사람의 라인별 승률을 보여줍니다. 전체 플레이어를 합치면 각 경기마다 라인별로 1승·1패가
              생겨 항상 50%이므로 보여주지 않습니다.
            </InfoTip>
          </h2>
          {playerLines === null ? (
            // 전체 플레이어를 합친 라인별 승률은 항상 50%라 그리지 않는다(까닭은 제목 옆 i 설명).
            <p className="hint">위 &lsquo;플레이어&rsquo;에서 한 사람을 고르면 그 사람의 라인별 승률을 보여줍니다.</p>
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
                        <RateBar label={POSITION_LABEL[position]} wins={tally.wins} games={tally.games} />
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

/** 프로필 묶음의 최근 흐름 칸 수. 개인 통계의 "최근 10경기"와 같게 둔다(바꾸면 두 화면이 다르게 보인다). */
const PROFILE_RECENT = 10;

/** 프로필 묶음의 승률 글: "63% · 5승 3패 (8경기)". */
function recordLine(wins: number, games: number): string {
  return games === 0 ? "이 범위에는 경기가 없어요" : `${percentText(wins, games)} · ${wins}승 ${games - wins}패 (${games}경기)`;
}

/**
 * 고른 플레이어 묶음(2026-11-09). 요약 타일 자리에 그 사람 중심으로: 이름·칭호·버튼 → 승률 고리·MMR 순위·최근 흐름·
 * 승률 추이·이변·참석 | 라인 모양. 계산은 개인 통계(Person.tsx)와 같은 공용 함수(resultsOf·personUpsets·attendance·
 * computeRatings)를 쓴다. 승패·이변·참석·라인은 고른 범위, MMR·순위·칭호는 누적 기준이다(개인 통계와 같은 규칙).
 * 입력의 ratings·expectations·attendance·matrix는 Graphs가 이미 계산한 것을 넘겨받는다(다시 계산하지 않게).
 */
function PlayerProfile(props: {
  snapshot: Snapshot;
  participantId: string;
  scoped: Snapshot["matches"];
  scopeLabel: string;
  ratings: ReturnType<typeof computeRatings>;
  expectations: ReturnType<typeof useExpectations>;
  attendance: ReturnType<typeof attendanceReport>;
  matrix: ReturnType<typeof playerLineMatrix>;
  standing: ShownStanding | undefined;
  cumulative: ReadonlyMap<string, { games: number }>;
  nameOf: (id: string) => string;
  openPerson: () => void;
  clear: () => void;
}) {
  const { snapshot, participantId: id, scoped, standing } = props;
  const name = snapshot.participants.find((p) => p.id === id)?.name ?? "";
  const results = useMemo(() => resultsOf(scoped, id), [scoped, id]);
  const wins = results.filter(Boolean).length;
  const streaks = streakOf(results);
  const recent10 = results.slice(-PROFILE_RECENT).reverse();
  // 개인 통계와 같은 규칙: 처음 몇 경기는 누적 승률이 크게 흔들려 SMALL_SAMPLE경기째부터 그린다.
  const trend = useMemo(() => cumulativeTrend(results).filter((p) => p.game >= SMALL_SAMPLE), [results]);
  const rating = props.ratings.get(id);
  const placementGames = placementGamesOf(snapshot.group.settings);
  const rank = ratingRank(props.ratings, id, placementGames);
  const upsets = personUpsets(props.expectations, scoped, id);
  const attend = props.attendance.people.get(id);
  const shape = lineShape(props.matrix.get(id) ?? {}, "rate");
  const hasLines = shape.some((a) => a.games > 0);
  const { ratings, expectations, attendance, cumulative, nameOf } = props;
  const notes = useMemo(
    () =>
      playerCommentary({ scoped, participantId: id, nameOf, ratings, expectations, attendance, cumulative, placementGames }),
    [scoped, id, nameOf, ratings, expectations, attendance, cumulative, placementGames],
  );
  return (
    <section className="graph-profile" aria-label="고른 플레이어">
      <div className="profile-head">
        <h2>{name}</h2>
        {standing?.title && <TitleBadge name={standing.title} grade={standing.grade} />}
        <span className="profile-actions">
          <button type="button" className="secondary" onClick={props.openPerson}>
            자세히
          </button>
          <button type="button" className="secondary" onClick={props.clear}>
            고르기 해제
          </button>
        </span>
      </div>
      {/* ─ 왼쪽(폰은 위): 승률 고리·MMR → 최근 흐름 → 승·패 띠 → 이변·참석 / 오른쪽(폰은 아래): 라인 모양 ─ */}
      <div className="profile-grid">
        <div className="profile-main">
          <div className="ps-hero">
            <RateRing wins={wins} games={results.length} />
            <div className="ps-main">
              <p className={`summary-line ${rateTier(wins, results.length)}`}>{recordLine(wins, results.length)}</p>
              <p className="hint">범위: {props.scopeLabel}</p>
              <p className="ps-rating">
                {rating && standing?.done ? (
                  <>
                    <span className="rating-num">
                      MMR {shownRating(rating.rating)}
                      {rank ? ` · ${rank.rank}위 / ${rank.total}명` : ""}
                    </span>{" "}
                    <RatingTierBadge rating={rating.rating} placed />
                  </>
                ) : (
                  <span className="rating-num">
                    배치 진행 중 · {standing?.games ?? 0}/{placementGames}경기
                  </span>
                )}{" "}
                <span className="hint">(누적 기준)</span>
              </p>
            </div>
          </div>
          {recent10.length > 0 && (
            <div className="ps-form">
              <span className="tile-label">
                최근 {recent10.length}경기 (왼쪽이 최근)
                {streaks.currentStreak !== 0 && (
                  <>
                    {" · "}
                    <strong className={streaks.currentStreak > 0 ? "streak win" : "streak loss"}>
                      {streakText(streaks.currentStreak)}
                    </strong>
                  </>
                )}
              </span>
              <FormDots results={recent10} />
            </div>
          )}
          {trend.length >= 2 ? (
            <TrendLine points={trend} />
          ) : results.length > 0 ? (
            <p className="hint">승률 추이는 {SMALL_SAMPLE + 1}경기부터 그려요.</p>
          ) : null}
          {(upsets.upsetWins > 0 || upsets.underdogGames > 0) && (
            <p className="hint" title={`이변 승: 경기 전 예상이 ${Math.round(UPSET_THRESHOLD * 100)}% 미만이던 팀으로 이긴 경기`}>
              이변 승 {upsets.upsetWins}회
              {upsets.underdogGames > 0 &&
                ` · 약팀일 때 승률 ${percentText(upsets.underdogWins, upsets.underdogGames)} (${upsets.underdogGames}경기)`}
            </p>
          )}
          {attend && (
            <p className="hint">
              참석 {attend.days}일 · 출석률 {percentText(attend.days, attend.eligibleDays)} · 연속 {attend.currentStreak}일
            </p>
          )}
        </div>
        <div className="profile-shape">
          <span className="tile-label">라인 모양 (승률)</span>
          {hasLines ? (
            <LineShapeChart entries={[{ key: id, label: name, axes: shape, slot: 1 }]} mode="rate" small />
          ) : (
            <p className="hint">포지션 기록이 없어요.</p>
          )}
        </div>
      </div>
      <CommentaryCard notes={notes} />
    </section>
  );
}

/** 분석 코멘트 카드: 총평 한 줄(굵게) + 문장 목록. 문장 앞 점 색은 tone(좋음 초록 · 주의 주황 · 보통 회색). */
function CommentaryCard(props: { notes: Commentary }) {
  const { summary, remarks } = props.notes;
  return (
    <section className="commentary" aria-label="분석 코멘트">
      <h2>분석 코멘트</h2>
      {remarks.length === 0 ? (
        <p className="commentary-empty">경기가 쌓이면 코멘트가 생겨요.</p>
      ) : (
        <>
          {summary && <p className="commentary-summary">{summary}</p>}
          <ul className="commentary-remarks">
            {remarks.map((r) => (
              <li key={r.text} className={`remark-${r.tone}`}>
                {r.text}
                {/* 근거는 title 풍선이 아니라 글로 둔다(터치 화면에서는 풍선이 뜨지 않는다). */}
                {r.basis && <span className="remark-basis">기준: {r.basis}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="hint commentary-note">기록 수치를 규칙으로 읽어 쓴 평가예요.</p>
    </section>
  );
}


/**
 * 승률 색 범례: 3단(낮음·기준·높음)과 5경기 미만. 막대 그래프와 표가 같이 쓴다.
 * 경계 글자는 format.ts의 rateHeat 경계에서 만든다. 높은 쪽은 화면 정수 승률이 경계(55)를 넘어야 하므로 "56% 이상"이다.
 * 클래스는 각 단의 대표(heat-l4·heat-0·heat-h4)를 쓴다. 세 단 안에서는 h1~h4, l1~l4가 같은 색이다.
 */
function HeatLegend() {
  const bands = [
    { cls: "heat-l4", label: `${RATE_HEAT_COLD[0]}% 미만` },
    { cls: "heat-0", label: `${RATE_HEAT_COLD[0]}~${RATE_HEAT_HOT[0]}%` },
    { cls: "heat-h4", label: `${RATE_HEAT_HOT[0] + 1}% 이상` },
  ];
  return (
    <ul className="legend" aria-label="승률 색 범례">
      {bands.map((b) => (
        <li key={b.cls}>
          <span className={`swatch ${b.cls}`} aria-hidden="true" />
          {b.label}
        </li>
      ))}
      <li>
        <span className="swatch band-none" aria-hidden="true" />
        {SMALL_SAMPLE}경기 미만 (색 없음)
      </li>
    </ul>
  );
}

/**
 * 플레이어 × 라인 표. 머리 행은 화면을 내려도 붙어 있고(sticky), 라인에는 아이콘, 이름은 개인 통계로 가는 버튼이다.
 * 칸은 승률(굵게)과 경기 수(작게). 바탕은 모든 칸이 같은 중립색이고 승률 글자만 막대와 같은 3단 색이다.
 */
function MatrixTable(props: {
  rows: PersonRecord[];
  matrix: ReturnType<typeof playerLineMatrix>;
  nameOf: (id: string) => string;
  playerId: string;
  openPerson: (id: string) => void;
}) {
  const { rows, matrix, nameOf, playerId } = props;
  if (rows.length === 0) return null;
  return (
    <table className="matrix">
      <thead>
        <tr>
          <th scope="col">이름</th>
          {POSITIONS.map((p) => (
            <th key={p} scope="col">
              <PosLabel position={p} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const row = matrix.get(r.participantId) ?? {};
          return (
            // 행 전체를 눌러 개인 통계로 간다(이름 글자만 누르기에는 작다, 2026-11-08). 키보드는 이름 버튼으로.
            <tr
              key={r.participantId}
              className={r.participantId === playerId ? "matrix-row picked" : "matrix-row"}
              onClick={() => props.openPerson(r.participantId)}
            >
              <th scope="row" title={nameOf(r.participantId)}>
                <button
                  type="button"
                  className="matrix-name"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.openPerson(r.participantId);
                  }}
                >
                  {nameOf(r.participantId)}
                </button>
              </th>
              {POSITIONS.map((position) => {
                const tally = row[position];
                return tally ? (
                  <td
                    key={position}
                    className={cellBand(tally)}
                    title={`${nameOf(r.participantId)} ${POSITION_LABEL[position]}: ${tally.wins}승 ${tally.games - tally.wins}패`}
                  >
                    <strong className="cell-rate">{ratePercent(tally.wins, tally.games)}%</strong>
                    <span className="cell-games">{tally.games}경기</span>
                  </td>
                ) : (
                  <td key={position} className="band-empty" aria-label="기록 없음">
                    —
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
