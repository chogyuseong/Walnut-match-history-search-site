import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  personForms,
  RANKING_GROUP_LABEL,
  RANKING_VETERAN_GAMES,
  rankingGroup,
  recentResults,
  type RankedRow,
} from "../../shared/insights";
import {
  divergingBar,
  mmrRanking,
  mmrScale,
  rankingGroupSizes,
  rankingHighlights,
  ratingTierCounts,
  type MmrScale,
} from "../../shared/ranking";
import {
  computeRatings,
  expectedScore,
  RATING_HALF_LIFE,
  RATING_PRIOR_GAMES,
  RATING_RECENT_GAMES,
  RATING_TIER_HELP,
  ratingTrend,
  shownRating,
  signedDelta,
  ratingOptionsOf,
  STREAK_K_MAX,
  STREAK_K_START,
  streakMultiplier,
  type RatingOptions,
} from "../../shared/rating";
import type { Snapshot } from "../../shared/types";
import { nameMap, peopleBarStep, rankClass, rateText, rateTier, standingsOf } from "../format";
import {
  FilterBar,
  FormDots,
  Glue,
  Help,
  InfoTip,
  Meter,
  RatingTierBadge,
  RatingTrendLine,
  ScreenHead,
  SortHead,
  StatCard,
  TitleBadge,
  type SortState,
} from "../screenKit";
import { useSearchJump } from "../ui";

/**
 * MMR 랭킹 화면(#/ranking, 조회 링크·예시 모임은 …/ranking). 결과 기반 MMR(rating.ts) 순위표.
 * 틀(2026-11-10 구조 정리): 화면 머리 → 필터 줄(이름 검색) → 요약 카드 줄(1위 · 최근 상승 · 최고 기록 · 티어 분포) → 순위표.
 * 순위표는 머리 줄이 있는 표 모양 목록이다. 줄은 listitem이라 묶음 소제목(.rank-group)과 펼친 추이가 줄 사이에 낄 수 있다.
 * 열: 순위 | 이름·칭호 | 시작값 기준 막대 | MMR | 티어 | 최근 변동 | 경기 | 승률 | 최근 10경기 | 펼치기.
 * MMR·최근 변동·경기·승률 머리를 누르면 그 열로 줄을 다시 세운다. 묶음(누적 50경기 이상 → 배치 완료 → 배치 진행 중)은 정렬해도
 * 그대로라, 몇 판 안 한 사람이 승률 100%로 맨 위에 오지 않는다. 순위 숫자는 MMR 순위 그대로다(검색할 때와 같은 규칙).
 * 데이터는 스냅숏의 경기에서 기기가 매번 계산한다(computeRatings · standingsOf · personForms). 범위 없이 모임 전체 누적이다.
 */

/** 설명에 예시로 드는 팀 평균 MMR 차이(점). 차이가 예상 승률로 얼마인지 감을 주려는 값이라 바꿔도 계산과 무관하다. */
const EXAMPLE_GAPS = [100, 200];

/** "3연속 1.25배 · 4연속 1.375배 · 5연속부터 1.5배". rating.ts의 가중 상수를 바꾸면 설명도 따라 바뀌게 계산해서 적는다. */
function streakStepsText(): string {
  const steps: string[] = [];
  for (let run = STREAK_K_START; ; run++) {
    const weight = streakMultiplier(run);
    if (weight >= STREAK_K_MAX) {
      steps.push(`${run}연속부터 ${weight}배`);
      return steps.join(" · ");
    }
    steps.push(`${run}연속 ${weight}배`);
  }
}

/**
 * 화면 제목 옆 i 버튼: MMR이 어떻게 정해지는지. 숫자는 모임 설정과 rating.ts 상수에서 가져온다.
 * 계산 규칙(shared/rating.ts)을 바꾸면 이 설명의 문장도 같이 고친다.
 */
function RatingRuleTip(props: { options: RatingOptions }) {
  const { start } = props.options;
  const gapExamples = EXAMPLE_GAPS.map(
    (gap) => `${gap}점 높으면 약 ${Math.round(expectedScore(start + gap, start) * 100)}%`,
  ).join(", ");
  return (
    <InfoTip label="MMR 계산 기준">
      <span className="tip-line">
        MMR은 같은 팀원과 상대 팀이 누구였는지까지 감안한 실력 점수예요. 모두 {start}점에서 시작하고, 보는 범위와 상관없이
        모임 전체의 확정 경기로 계산합니다. 결과 미입력·진행 중·취소·전적 제외 경기는 세지 않아요.
      </span>
      <span className="tip-line">
        계산: 지금까지의 경기를 한꺼번에 놓고, 모든 경기의 승패를 가장 잘 설명하는 점수를 사람마다 찾습니다. 늘 약한 팀원과
        묶이면서도 반반을 거둔 사람은 높게, 강한 팀원 덕에 이긴 판은 덜 쳐 줘요. 경기마다 조금씩 더하고 빼는 Elo와 달리
        경기 순서의 운을 덜 탑니다.
      </span>
      <span className="tip-line">
        예상 승률: 팀 MMR은 팀원 MMR의 평균이고, 예상 승률 = 1 ÷ (1 + 10^((상대 팀 − 우리 팀) ÷ 400))입니다. 두 팀 평균이
        같으면 50%, 우리 팀이 {gapExamples}예요.
      </span>
      <span className="tip-line">
        판수가 적을 때: 모두 평균 팀과 반반 비긴 가상 경기 {RATING_PRIOR_GAMES}판을 안고 시작해요. 몇 판 운 좋게 이긴 것만으로
        크게 튀지 않고, 경기가 쌓일수록 제자리를 찾아갑니다.
      </span>
      <span className="tip-line">
        최근 경기 우선: 모임 경기가 {RATING_HALF_LIFE}판 쌓일 때마다 그 전 결과의 무게가 절반이 돼요. 실력이 오르면 역전할 수
        있고, 오래 쉬면 점수가 {start}점 쪽으로 천천히 돌아옵니다.
      </span>
      <span className="tip-line">
        연승·연패 가중: 같은 결과가 이어진 경기는 더 무겁게 셉니다({streakStepsText()}). 승패가 바뀌면 다시 1배예요.
      </span>
      <span className="tip-line">
        경기 하나의 변화는 그 경기를 넣고 다시 계산한 점수 차예요. 다른 경기 결과로 예전 상대가 다시 평가되면 안 뛴 날에도
        점수가 몇 점 움직일 수 있어요.
      </span>
      <span className="tip-line">
        티어: {RATING_TIER_HELP} 배치 중에는 티어를 붙이지 않아요. 점수는 소수까지 계산하고 화면에는 반올림해 보여 줍니다.
      </span>
    </InfoTip>
  );
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
  const rankJump = useSearchJump<HTMLElement>();
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
  const desc = `누적 기준 · 확정 경기만 · 시작 ${ratingOptions.start} · 연승·연패 가중 · ${RANKING_GROUP_LABEL[0]} 먼저`;
  const championLink = props.openChampions && (
    <button type="button" className="link" onClick={props.openChampions}>
      챔피언 티어 →
    </button>
  );

  if (ranking.ranked.length === 0) {
    return (
      <div className="screen page-wide mmr-ranking">
        <ScreenHead title="MMR 랭킹" badge={<RatingRuleTip options={ratingOptions} />} desc={desc} actions={championLink} />
        <div className="empty-state">
          <p>확정 경기가 쌓이면 보여요. 경기 결과를 하나 저장하면 바로 순위가 생깁니다.</p>
          {props.emptyAction}
        </div>
      </div>
    );
  }

  const { leader, riser, peak } = highlights;
  const leaderStanding = leader ? placement.get(leader.row.participantId) : undefined;

  return (
    <div className="screen page-wide mmr-ranking">
      <ScreenHead title="MMR 랭킹" badge={<RatingRuleTip options={ratingOptions} />} desc={desc} actions={championLink} />

      <FilterBar label="순위표 찾기" meta={`${ranking.ranked.length}명`}>
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
      </FilterBar>

      <section aria-label="랭킹 요약">
        <h2 className="sr-only">요약</h2>
        {/* 세 카드 모두 누적 50경기 이상인 사람만 후보다(rankingHighlights). 그런 사람이 없으면 셋 다 비고,
            까닭은 1위 카드에만 한 번 적는다. 카드별 제목 색은 styles.css .mmr-cards(CLAUDE.md 5절 예외). */}
        <div className="stat-cards mmr-cards">
          {leader ? (
            <StatCard
              className="mmr-lead-card"
              title={
                <>
                  1위
                  {leaderStanding?.title && <> · {leaderStanding.title}</>}
                </>
              }
              lead={
                <button type="button" className="link stat-card-name" onClick={() => props.openPerson(leader.row.participantId)}>
                  {leader.row.name}
                </button>
              }
              value={
                <>
                  {shownRating(leader.rating.rating)}
                  <span className="stat-card-unit"> MMR</span> <DeltaChip delta={leader.rating.delta10} />
                </>
              }
              rows={[
                ["경기 · 승률", `${leader.row.games}경기 · ${rateText(leader.row.wins, leader.row.games)}`],
                ["최고", shownRating(leader.rating.peak)],
              ]}
            >
              <FormDots
                results={recentResults(forms.get(leader.row.participantId), RATING_RECENT_GAMES)}
                label={`최근 ${RATING_RECENT_GAMES}경기(왼쪽이 최근)`}
              />
            </StatCard>
          ) : (
            <StatCard className="mmr-lead-card" title="1위" value="—">
              <p className="hint">누적 {RANKING_VETERAN_GAMES}경기를 채운 사람부터 요약 카드 셋에 올라요.</p>
            </StatCard>
          )}
          <StatCard
            className="mmr-rise-card"
            title={`최근 ${RATING_RECENT_GAMES}경기 최고 상승`}
            lead={riser?.row.name}
            value={riser ? <span className="mmr-delta up">{signedDelta(riser.rating.delta10)}</span> : "—"}
            rows={riser ? [["지금 MMR", shownRating(riser.rating.rating)]] : []}
          />
          <StatCard
            className="mmr-peak-card"
            title="최고 MMR 기록"
            lead={peak?.row.name}
            value={peak ? shownRating(peak.rating.peak) : "—"}
            rows={peak ? [["지금 MMR", shownRating(peak.rating.rating)]] : []}
          />
        </div>
      </section>

      <section ref={rankJump.results} tabIndex={-1} className="search-results" aria-label="MMR 순위표">
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
                        {/* 826점이 16위, 1269점이 17위처럼 점수와 순번이 어긋나 보이는 자리라 까닭을 경계에 적는다. */}
                        {group === 1 && groupSizes[0] > 0 && (
                          <span className="rank-group-why">
                            경기 수가 적어 MMR이 높아도 {RANKING_GROUP_LABEL[0]} 아래에 세워요
                          </span>
                        )}
                      </li>
                    )}
                    <li className="mmr-item">
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
                          <span className="c-bar">
                            {rating && scale && <StartBar rating={rating.rating} scale={scale} step={peopleBarStep(row.wins, row.games)} />}
                          </span>
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
        {/* 티어 분포는 요약 카드(최대 셋)에서 순위표 아래 한 줄로 내렸다. */}
        {tierCounts.length > 0 && (
          <p className="hint mmr-tier-counts">
            티어 분포 {tierCounts.reduce((sum, t) => sum + t.count, 0)}명 ·{" "}
            {tierCounts.map(({ tier, count }) => `${tier.short} ${count}`).join(" · ")}
          </p>
        )}
        <Help label="순서와 막대 읽는 법">
          순서는{" "}
          {RANKING_GROUP_LABEL[0]} → 배치 완료 → 배치 진행 중이고, 묶음 안에서는 MMR → 승률 → 경기 수 → 이름입니다.
          MMR·최근 변동·경기·승률 머리를 누르면 묶음은 그대로 둔 채 묶음 안에서 그 열의 큰 값부터 다시 세웁니다(순위 숫자는 MMR 순위 그대로).
          맨 위 요약 카드 셋(1위·최고 상승·최고 MMR)은 {RANKING_GROUP_LABEL[0]}인 사람 중에서만 뽑고, 그런 사람이 아직 없으면 비워 둡니다. 막대는 시작 {ratingOptions.start}을 세로 기준선으로 두고
          오른쪽은 그보다 오른 만큼, 왼쪽은 내린 만큼이며 양 끝은 순위표의 가장 낮은·높은 MMR입니다. 배치 진행 중({placementGames}경기 미만)은 점수가 크게 흔들려 MMR 대신 배치 판수를 보여 주고
          요약 카드·강조에서도 뺍니다. 이름을 검색해도 순위 숫자는 그대로예요. ▾를 누르면 그 사람의 MMR 추이가 펼쳐집니다.
        </Help>
      </section>
    </div>
  );
}

/** 최근 10경기 변화: 오르면 본문 글자 "▲ 28", 내리면 보조 글자 "▼ 7", 그대로면 "–"(바탕 없음). 오르내림은 화살표가 전한다. */
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
/** step: 승률 여섯 칸 클래스(peopleBarStep). 막대 모양(위는 채움·아래는 속 빈 테두리)은 MMR, 색은 그 사람 승률을 따른다. */
function StartBar(props: { rating: number; scale: MmrScale; step: string }) {
  const { scale } = props;
  const bar = divergingBar(props.rating, scale);
  const diff = shownRating(props.rating) - shownRating(scale.start);
  const style = {
    "--at": divergingBar(scale.start, scale).left,
    "--left": bar.left,
    "--width": bar.width,
  } as CSSProperties;
  const tone = bar.up ? "up" : "down";
  return (
    <span className="mmr-start-bar">
      <span className="sr-only">
        시작 {shownRating(scale.start)}보다 {diff === 0 ? "그대로" : signedDelta(diff)}
      </span>
      <span className="mmr-start-track" style={style} aria-hidden="true">
        <span className={`mmr-start-fill ${tone} ${props.step}`.trim()} />
        <span className="mmr-start-line" />
      </span>
    </span>
  );
}
