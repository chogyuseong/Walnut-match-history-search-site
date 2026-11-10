import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { personForms, RANKING_GROUP_LABEL, rankingGroup, recentResults, type RankedRow } from "../../shared/insights";
import {
  divergingBar,
  mmrRanking,
  mmrScale,
  podiumOf,
  rankingGroupSizes,
  rankingHighlights,
  ratingTierCounts,
  type MmrScale,
} from "../../shared/ranking";
import {
  computeRatings,
  RATING_RECENT_GAMES,
  RATING_TIER_HELP,
  ratingTrend,
  shownRating,
  signedDelta,
  ratingOptionsOf,
} from "../../shared/rating";
import type { Snapshot } from "../../shared/types";
import { nameMap, rankClass, rateText, rateTier, standingsOf } from "../format";
import {
  FilterBar,
  FormDots,
  Glue,
  Help,
  Meter,
  RatingTierBadge,
  RatingTrendLine,
  ScreenHead,
  SortHead,
  StatCard,
  TitleBadge,
  type SortState,
} from "../screenKit";

/**
 * MMR 랭킹 화면(#/ranking, 조회 링크·예시 모임은 …/ranking). 결과 기반 MMR(rating.ts) 순위표.
 * 틀(2026-11-10 구조 정리): 화면 머리 → 필터 줄(이름 검색) → 요약 카드 줄(1위 · 최근 상승 · 최고 기록 · 티어 분포) → 순위표.
 * 순위표는 머리 줄이 있는 표 모양 목록이다. 줄은 listitem이라 묶음 소제목(.rank-group)과 펼친 추이가 줄 사이에 낄 수 있다.
 * 열: 순위 | 이름·칭호 | 시작값 기준 막대 | MMR | 티어 | 최근 변동 | 경기 | 승률 | 최근 10경기 | 펼치기.
 * MMR·최근 변동·경기·승률 머리를 누르면 그 열로 줄을 다시 세운다. 묶음(누적 50경기 이상 → 배치 완료 → 배치 진행 중)은 정렬해도
 * 그대로라, 몇 판 안 한 사람이 승률 100%로 맨 위에 오지 않는다. 순위 숫자는 MMR 순위 그대로다(검색할 때와 같은 규칙).
 * 데이터는 스냅숏의 경기에서 기기가 매번 계산한다(computeRatings · standingsOf · personForms). 범위 없이 모임 전체 누적이다.
 */

/** 등장 효과를 차례로 늦추는 행 수. 그 아래 행은 10번째와 함께 나타난다(긴 목록이 오래 기다리지 않게). */
const ENTER_STAGGER_ROWS = 10;
/** 등장 효과 순번(CSS 변수 --enter). */
function enterStyle(index: number): CSSProperties {
  return { "--enter": Math.min(index, ENTER_STAGGER_ROWS - 1) } as CSSProperties;
}

type RankSortKey = "rating" | "delta" | "games" | "rate";
/** 정렬은 큰 값부터 하나뿐이다. 작은 값부터는 표본이 적은 사람·배치 중인 사람이 위로 와 읽을 거리가 없다. */
const DEFAULT_SORT: SortState<RankSortKey> = { key: "rating", dir: "desc" };

export function Ranking(props: {
  snapshot: Snapshot;
  openPerson: (id: string) => void;
  /** 운영자에게만: 확정 경기가 없을 때 보여 줄 입력 버튼(팀 짜기 등). 조회 화면은 안내 글만 둔다. */
  emptyAction?: ReactNode;
  /**
   * 챔피언 티어로 가는 머리 링크. 좁은 화면의 하단 메뉴는 칸이 모자라 운영자·참가자 메뉴에서 "챔피언"을 뺐으므로
   * 폰에서는 이 링크가 챔피언 티어로 가는 길이다(넓은 화면에서는 메뉴와 겹치지만 같이 둔다).
   */
  openChampions?: () => void;
}) {
  const { snapshot } = props;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState<RankSortKey>>(DEFAULT_SORT);
  // 추이를 펼친 사람. 한 번에 하나만 펼친다(목록이 길어 여러 개면 내려가며 찾기 어렵다).
  const [openTrend, setOpenTrend] = useState<string | null>(null);
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const ratingOptions = ratingOptionsOf(snapshot.group.settings);
  const { placementGames } = ratingOptions;
  const placement = useMemo(() => standingsOf(snapshot), [snapshot]);
  const table = useMemo(() => computeRatings(snapshot.matches, ratingOptionsOf(snapshot.group.settings)), [snapshot]);
  const forms = useMemo(() => personForms(snapshot.matches), [snapshot]);
  const ranking = useMemo(
    () => mmrRanking(snapshot.matches, table, placement, nameOf, query),
    [snapshot, table, placement, nameOf, query],
  );
  const highlights = useMemo(() => rankingHighlights(ranking.ranked, table, placement), [ranking, table, placement]);
  const groupSizes = useMemo(() => rankingGroupSizes(ranking.ranked, placement), [ranking, placement]);
  const scale = useMemo(
    () => mmrScale(ranking.ranked, table, placement, ratingOptions.start),
    [ranking, table, placement, ratingOptions.start],
  );
  // 1위 칸은 시상대 규칙(podiumOf: 누적 50경기 이상 묶음)의 1위를 먼저 세운다. 그런 사람이 아직 없으면(새 모임)
  // 배치를 마친 사람 중 맨 위(highlights.leader)를 "1위"로 두되 경기 수를 함께 적어 표본이 작다는 것을 숨기지 않는다.
  const veteranLeader = useMemo(
    () => podiumOf(ranking.ranked, placement).find((row) => row.rank === 1) ?? null,
    [ranking, placement],
  );
  const leaderRow = veteranLeader ?? highlights.leader?.row ?? null;
  const tierCounts = useMemo(() => ratingTierCounts(ranking.ranked, table, placement), [ranking, table, placement]);
  const rows = useMemo(() => {
    if (sort.key === "rating") return ranking.shown;
    const value = (row: RankedRow): number => {
      if (sort.key === "games") return row.games;
      if (sort.key === "rate") return row.games > 0 ? row.wins / row.games : 0;
      // 배치 진행 중은 변동을 보여 주지 않으므로 그 묶음 안에서는 순위 순서를 지킨다.
      return placement.get(row.participantId)?.done ? (table.get(row.participantId)?.delta10 ?? 0) : 0;
    };
    return [...ranking.shown].sort(
      (a, b) =>
        rankingGroup(placement, a.participantId) - rankingGroup(placement, b.participantId) ||
        value(b) - value(a) ||
        a.rank - b.rank,
    );
  }, [ranking, sort, placement, table]);
  // 검색 결과는 일치도 순이라 묶음이 섞이므로 검색하지 않을 때만 묶음 머리글을 둔다.
  const groupHeads = query.trim() === "";
  const desc = `누적 기준 · 확정 경기만 · 시작 ${ratingOptions.start} · 연승·연패 가중`;
  const championLink = props.openChampions && (
    <button type="button" className="link" onClick={props.openChampions}>
      챔피언 티어 →
    </button>
  );

  if (ranking.ranked.length === 0) {
    return (
      <div className="screen page-wide mmr-ranking">
        <ScreenHead title="MMR 랭킹" desc={desc} actions={championLink} />
        <div className="empty-state">
          <p>확정 경기가 쌓이면 보여요. 경기 결과를 하나 저장하면 바로 순위가 생깁니다.</p>
          {props.emptyAction}
        </div>
      </div>
    );
  }

  const leaderRating = leaderRow ? table.get(leaderRow.participantId) : undefined;
  const leaderStanding = leaderRow ? placement.get(leaderRow.participantId) : undefined;

  return (
    <div className="screen page-wide mmr-ranking">
      <ScreenHead title="MMR 랭킹" desc={desc} actions={championLink} />

      <FilterBar label="순위표 찾기" meta={`${ranking.ranked.length}명`}>
        <input
          type="search"
          className="filter-search"
          aria-label="이름 검색"
          placeholder="이름 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </FilterBar>

      <section aria-label="랭킹 요약">
        <h2 className="sr-only">요약</h2>
        <div className="stat-cards mmr-cards">
          {leaderRow && leaderRating ? (
            <StatCard
              tone="lead"
              className="mmr-lead-card"
              title={
                <>
                  1위
                  {leaderStanding?.title && <> · {leaderStanding.title}</>}
                  {!veteranLeader && <> · 배치 완료자 중</>}
                </>
              }
              lead={
                <button type="button" className="link stat-card-name" onClick={() => props.openPerson(leaderRow.participantId)}>
                  {leaderRow.name}
                </button>
              }
              value={
                <>
                  {shownRating(leaderRating.rating)}
                  <span className="stat-card-unit"> MMR</span> <DeltaChip delta={leaderRating.delta10} />
                </>
              }
              rows={[
                ["경기 · 승률", `${leaderRow.games}경기 · ${rateText(leaderRow.wins, leaderRow.games)}`],
                ["최고", shownRating(leaderRating.peak)],
              ]}
            >
              <FormDots
                results={recentResults(forms.get(leaderRow.participantId), RATING_RECENT_GAMES)}
                label={`최근 ${RATING_RECENT_GAMES}경기(왼쪽이 최근)`}
              />
            </StatCard>
          ) : (
            <StatCard title="1위" value="—" rows={[["배치", `${placementGames}경기를 마치면 순위가 생겨요`]]} />
          )}
          <StatCard
            title={`최근 ${RATING_RECENT_GAMES}경기 최고 상승`}
            lead={highlights.riser?.row.name}
            value={
              highlights.riser ? <span className="mmr-delta up">{signedDelta(highlights.riser.rating.delta10)}</span> : "—"
            }
            rows={highlights.riser ? [["지금 MMR", shownRating(highlights.riser.rating.rating)]] : []}
          />
          <StatCard
            title="최고 MMR 기록"
            lead={highlights.peak?.row.name}
            value={highlights.peak ? shownRating(highlights.peak.rating.peak) : "—"}
            rows={highlights.peak ? [["지금 MMR", shownRating(highlights.peak.rating.rating)]] : []}
          />
          {tierCounts.length > 0 && (
            <StatCard title="티어 분포" value={`${tierCounts.reduce((sum, t) => sum + t.count, 0)}명`}>
              <p className="mmr-tier-counts">
                <span className="sr-only">티어별 인원: </span>
                {/* 줄마다 "골드 … 5". 글자 내용은 "골드 5"로 이어 읽힌다. */}
                {tierCounts.map(({ tier, count }) => (
                  <span key={tier.key} className="mmr-tier-count">
                    <span>{tier.short}</span> <span>{count}</span>
                  </span>
                ))}
              </p>
            </StatCard>
          )}
        </div>
      </section>

      <section aria-label="MMR 순위표">
        <h2 className="sr-only">순위표</h2>
        {rows.length === 0 ? (
          <p className="hint">일치하는 이름이 없어요.</p>
        ) : (
          <div className="dt-list mmr-table">
            <SortHead
              label="순위표 정렬"
              className="mmr-grid mmr-head"
              sort={sort}
              onSort={(key) => setSort({ key, dir: "desc" })}
              cells={[
                { cls: "c-rank", label: "#" },
                { cls: "c-who", label: "이름" },
                { cls: "c-bar keep", label: scale ? <ScaleAxis scale={scale} /> : "" },
                { cls: "c-mmr", label: "MMR", sort: "rating", num: true },
                { cls: "c-tier", label: "티어" },
                { cls: "c-delta", label: "최근 변동", sort: "delta", num: true },
                { cls: "c-games", label: "경기", sort: "games", num: true },
                { cls: "c-rate", label: "승률", sort: "rate", num: true },
                { cls: "c-form", label: `최근 ${RATING_RECENT_GAMES}경기` },
                { cls: "c-toggle", label: "" },
              ]}
            />
            <ul className="list list-card mmr-list">
              {rows.map((row, i) => {
                const rating = table.get(row.participantId);
                const standing = placement.get(row.participantId);
                const group = rankingGroup(placement, row.participantId);
                const prev = i > 0 ? rankingGroup(placement, rows[i - 1]!.participantId) : null;
                const placing = !standing?.done;
                const open = openTrend === row.participantId;
                const trendId = `mmr-trend-${row.participantId}`;
                return (
                  <Fragment key={row.participantId}>
                    {groupHeads && group !== prev && (
                      // 순위 줄 개수(listitem)에 섞이지 않도록 머리글은 목록 항목 역할을 갖지 않는다.
                      <li className="rank-group" role="presentation">
                        {RANKING_GROUP_LABEL[group]} · {groupSizes[group]}명
                      </li>
                    )}
                    <li className="mmr-item mmr-enter" style={enterStyle(i)}>
                      <div className="list-row static mmr-grid mmr-row">
                        {/* 배치 진행 중은 순위가 높아 보여도 강조하지 않는다(점수가 아직 흔들린다). */}
                        <span className={`c-rank ${rankClass(row.rank, placing)}`}>{row.rank}</span>
                        <span className="c-who mmr-who">
                          <button type="button" className="link mmr-name" onClick={() => props.openPerson(row.participantId)}>
                            {row.name}
                          </button>
                          {standing?.title && <TitleBadge name={standing.title} grade={standing.grade} compact />}
                        </span>
                        {placing ? (
                          <span className="c-bar mmr-placing-cell">
                            <span className="mmr-placing">
                              배치 {row.games}/{placementGames}
                            </span>
                            <Meter value={row.games / placementGames} tone="share" small />
                          </span>
                        ) : (
                          <span className="c-bar">{rating && scale && <StartBar rating={rating.rating} scale={scale} top={row.rank === 1} />}</span>
                        )}
                        {/* MMR·티어·변동: 넓은 화면에서는 칸 셋, 좁은 화면에서는 한 덩어리(display: contents ↔ flex). */}
                        <span className="mmr-score">
                          <span className="c-mmr num">
                            {!placing && rating ? <strong className="mmr-value">{shownRating(rating.rating)}</strong> : <span className="hint">–</span>}
                          </span>
                          <span className="c-tier">{!placing && rating && <RatingTierBadge rating={rating.rating} placed />}</span>
                          <span className="c-delta num">{!placing && rating && <DeltaChip delta={rating.delta10} />}</span>
                        </span>
                        <span className="mmr-meta">
                          <span className="c-games num">
                            {row.games}
                            <Glue>경기 · </Glue>
                          </span>
                          <span className="c-rate num">
                            <span className={rateTier(row.wins, row.games)}>{rateText(row.wins, row.games)}</span>
                          </span>
                          <span className="c-form">
                            <FormDots
                              results={recentResults(forms.get(row.participantId), RATING_RECENT_GAMES)}
                              label={`최근 ${RATING_RECENT_GAMES}경기(왼쪽이 최근)`}
                            />
                          </span>
                        </span>
                        <button
                          type="button"
                          className="c-toggle mmr-toggle"
                          aria-expanded={open}
                          aria-controls={trendId}
                          aria-label={`${row.name} MMR 추이`}
                          onClick={() => setOpenTrend(open ? null : row.participantId)}
                        >
                          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
                        </button>
                      </div>
                      {open && rating && (
                        <div id={trendId} className="mmr-trend">
                          <RatingTrendLine points={ratingTrend(rating.history)} start={ratingOptions.start} />
                        </div>
                      )}
                    </li>
                  </Fragment>
                );
              })}
            </ul>
          </div>
        )}
        <Help label="MMR과 순서">
          MMR은 상대 팀의 평균 MMR을 감안해 승패마다 오르내리는 점수예요(시작 {ratingOptions.start}). 3연승·3연패부터 변화 폭이 커져요(최대 1.5배). {RATING_TIER_HELP} 순서는{" "}
          {RANKING_GROUP_LABEL[0]} → 배치 완료 → 배치 진행 중이고, 묶음 안에서는 MMR → 승률 → 경기 수 → 이름입니다.
          MMR·최근 변동·경기·승률 머리를 누르면 묶음은 그대로 둔 채 묶음 안에서 그 열의 큰 값부터 다시 세웁니다(순위 숫자는 MMR 순위 그대로).
          맨 위 1위 칸은 {RANKING_GROUP_LABEL[0]}인 사람의 1위이고, 그런 사람이 아직 없으면 배치를 마친 사람 중 1위예요. 막대는 시작 {ratingOptions.start}을 세로 기준선으로 두고
          오른쪽은 그보다 오른 만큼, 왼쪽은 내린 만큼이며 양 끝은 순위표의 가장 낮은·높은 MMR입니다. 배치 진행 중({placementGames}경기 미만)은 점수가 크게 흔들려 MMR 대신 배치 판수를 보여 주고
          요약 카드·강조에서도 뺍니다. 이름을 검색해도 순위 숫자는 그대로예요. ▾를 누르면 그 사람의 MMR 추이가 펼쳐집니다.
        </Help>
      </section>
    </div>
  );
}

/** 최근 10경기 변화: 오르면 초록 글자 "▲ 28", 내리면 빨강 글자 "▼ 7", 그대로면 회색 "–"(바탕 없음). 화살표로도 구분한다. */
function DeltaChip(props: { delta: number }) {
  const value = Math.round(props.delta);
  const shown = value > 0 ? `▲ ${value}` : value < 0 ? `▼ ${-value}` : "–";
  return (
    <span className={value > 0 ? "delta-chip up" : value < 0 ? "delta-chip down" : "delta-chip"}>
      <span className="sr-only">최근 {RATING_RECENT_GAMES}경기 {signedDelta(props.delta)}</span>
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}

/**
 * 머리 줄의 막대 칸 눈금: 왼쪽 끝 · 시작값 · 오른쪽 끝 MMR. 머리 줄과 줄이 같은 칸 배치를 써서 막대 바로 위에 선다.
 * 숫자는 막대마다 붙인 대체 글자(StartBar)가 이미 읽어 주므로 읽지 않는다. 시작값이 끝에 가까우면 끝 숫자와 겹쳐 끝 숫자를 뺀다.
 */
function ScaleAxis(props: { scale: MmrScale }) {
  const { scale } = props;
  const at = divergingBar(scale.start, scale).left;
  return (
    <span className="mmr-axis-scale" style={{ "--at": at } as CSSProperties} aria-hidden="true">
      {at > 0.2 && <span className="mmr-axis-lo">{shownRating(scale.lo)}</span>}
      <span className="mmr-axis-start">시작 {shownRating(scale.start)}</span>
      {at < 0.8 && <span className="mmr-axis-hi">{shownRating(scale.hi)}</span>}
    </span>
  );
}

/** 시작값 기준 막대. 위치·길이는 CSS 변수(--at 기준선, --left·--width 막대, 모두 0~1)로 넘긴다. */
function StartBar(props: { rating: number; scale: MmrScale; top: boolean }) {
  const { scale } = props;
  const bar = divergingBar(props.rating, scale);
  const diff = shownRating(props.rating) - shownRating(scale.start);
  const style = {
    "--at": divergingBar(scale.start, scale).left,
    "--left": bar.left,
    "--width": bar.width,
  } as CSSProperties;
  // 1위 줄만 포인트 색 막대(순위 숫자 색과 같은 규칙). 내려간 막대는 1위여도 패배 색이다.
  const tone = !bar.up ? "down" : props.top ? "up top" : "up";
  return (
    <span className="mmr-start-bar">
      <span className="sr-only">
        시작 {shownRating(scale.start)}보다 {diff === 0 ? "그대로" : signedDelta(diff)}
      </span>
      <span className="mmr-start-track" style={style} aria-hidden="true">
        <span className={`mmr-start-fill ${tone}`} />
        <span className="mmr-start-line" />
      </span>
    </span>
  );
}
