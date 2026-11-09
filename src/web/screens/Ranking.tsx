import { Fragment, useMemo, useState, type CSSProperties } from "react";
import { personForms, RANKING_GROUP_LABEL, rankingGroup, recentResults, type RankedRow } from "../../shared/insights";
import {
  mmrBarShare,
  mmrRanking,
  podiumOf,
  rankEmphasis,
  rankingGroupSizes,
  rankingHighlights,
  ratingTierCounts,
  ratingRangeByGroup,
  type RankingHighlight,
} from "../../shared/ranking";
import {
  computeRatings,
  RATING_RECENT_GAMES,
  RATING_TIER_HELP,
  ratingTrend,
  shownRating,
  signedDelta,
  type PersonRating,
  ratingOptionsOf,
} from "../../shared/rating";
import type { Snapshot } from "../../shared/types";
import { nameMap, rateText, rateTier, standingsOf, type ShownStanding } from "../format";
import { FormDots, Help, Meter, RatingTierBadge, RatingTrendLine, TitleBadge } from "../ui";

/**
 * MMR 랭킹 화면(#/ranking, 조회 링크·예시 모임은 …/ranking). 결과 기반 MMR(rating.ts) 순위표를 묶음별로 그린다.
 * 위에서부터 시상대(50경기 이상 1~3위) · 요약 타일 · 순위표. 상위일수록 색 띠·순위 색·막대로 눈에 띄게 한다.
 * 데이터는 스냅숏의 경기에서 기기가 매번 계산한다(computeRatings · standingsOf · personForms). 범위 없이 모임 전체 누적이다.
 * 순서·묶음은 기록 화면 "소환사 랭킹"의 MMR 순과 같다(shared/ranking.ts → insights.rankAndSearch).
 */

/** 등장 효과를 차례로 늦추는 행 수. 그 아래 행은 10번째와 함께 나타난다(긴 목록이 오래 기다리지 않게). */
const ENTER_STAGGER_ROWS = 10;
/** 시상대 칸 배치 순서: 왼쪽 2위 · 가운데 1위 · 오른쪽 3위. 폰에서는 CSS가 1·2·3 순서로 다시 세운다. */
const PODIUM_ORDER = [2, 1, 3];

/** 왕관 크기(px). 등수가 높을수록 크게 해 세로로 쌓인 폰 시상대에서도 차이가 보이게 한다. */
const PODIUM_CROWN_PX: Record<number, number> = { 1: 36, 2: 28, 3: 24 };
/** 목록 행 순위 칸의 왕관. 순위 칸 폭(2rem) 안에 들어가는 크기다. */
const ROW_CROWN_PX: Record<number, number> = { 1: 20, 2: 18, 3: 16 };

/** 금·은·동 왕관. 꾸밈이라 읽지 않고(순위 숫자가 뜻을 전한다) 색은 감싼 요소의 --medal을 currentColor로 받는다. */
function Crown(props: { size: number }) {
  return (
    <svg className="crown" width={props.size} height={props.size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 8l4.5 4L12 4.5l4.5 7.5L21 8l-2 9.5H5z" fill="currentColor" />
      <rect x="5" y="19" width="14" height="2.5" rx="1" fill="currentColor" />
    </svg>
  );
}

/** 등장 효과 순번(CSS 변수 --enter). */
function enterStyle(index: number): CSSProperties {
  return { "--enter": Math.min(index, ENTER_STAGGER_ROWS - 1) } as CSSProperties;
}

export function Ranking(props: { snapshot: Snapshot; openPerson: (id: string) => void }) {
  const { snapshot } = props;
  const [query, setQuery] = useState("");
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
  const ranges = useMemo(() => ratingRangeByGroup(ranking.ranked, table, placement), [ranking, table, placement]);
  const podium = useMemo(() => podiumOf(ranking.ranked, placement), [ranking, placement]);
  const tierCounts = useMemo(() => ratingTierCounts(ranking.ranked, table, placement), [ranking, table, placement]);
  // 검색 결과는 일치도 순이라 묶음이 섞이므로 검색하지 않을 때만 묶음 머리글을 둔다.
  const groupHeads = query.trim() === "";

  if (ranking.ranked.length === 0) {
    return (
      <div className="screen">
        <h1>MMR 랭킹</h1>
        <p>확정 경기가 쌓이면 보여요.</p>
      </div>
    );
  }

  return (
    <div className="screen mmr-ranking">
      <header className="screen-head">
        <h1>MMR 랭킹</h1>
      </header>
      <p className="hint">누적 기준 · 확정 경기만 · 시작 {ratingOptions.start} · 연승·연패 가중</p>
      {tierCounts.length > 0 && (
        <p className="mmr-tier-counts">
          <span className="sr-only">티어별 인원: </span>
          {tierCounts.map(({ tier, count }) => (
            <span key={tier.key} className={`mmr-tier mmr-tier-${tier.key}`}>
              {tier.short} {count}
            </span>
          ))}
        </p>
      )}

      {podium.length > 0 && (
        <section aria-label="시상대" className="mmr-podium">
          <h2 className="sr-only">누적 {RANKING_GROUP_LABEL[0]} 1~3위</h2>
          <ol>
            {PODIUM_ORDER.map((place) => podium.find((row) => row.rank === place))
              .filter((row) => row !== undefined)
              .map((row) => (
                <PodiumCell
                  key={row.participantId}
                  row={row}
                  rating={table.get(row.participantId)}
                  standing={placement.get(row.participantId)}
                  openPerson={props.openPerson}
                />
              ))}
          </ol>
        </section>
      )}

      <section aria-label="랭킹 요약">
        <h2 className="sr-only">요약</h2>
        {/* 시상대가 있으면 1위 타일은 같은 내용이라 뺀다. */}
        <dl className={podium.length > 0 ? "ps-tiles mmr-tiles two" : "ps-tiles mmr-tiles"}>
          {podium.length === 0 && (
            <HighlightTile label="1위" entry={highlights.leader} value={(r) => `MMR ${shownRating(r.rating)}`} />
          )}
          <HighlightTile
            label={`최근 ${RATING_RECENT_GAMES}경기 최고 상승`}
            entry={highlights.riser}
            value={(r) => signedDelta(r.delta10)}
            tone="up"
          />
          <HighlightTile label="최고 MMR 기록" entry={highlights.peak} value={(r) => `최고 ${shownRating(r.peak)}`} />
        </dl>
      </section>

      <section aria-label="MMR 순위표">
        <h2 className="sr-only">순위표</h2>
        <input
          type="search"
          aria-label="이름 검색"
          placeholder="이름 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {ranking.shown.length === 0 ? (
          <p className="hint">일치하는 이름이 없어요.</p>
        ) : (
          <ul className="list mmr-list">
            {ranking.shown.map((row, i) => {
              const rating = table.get(row.participantId);
              const standing = placement.get(row.participantId);
              const group = rankingGroup(placement, row.participantId);
              const prev = i > 0 ? rankingGroup(placement, ranking.shown[i - 1]!.participantId) : null;
              const placing = !standing?.done;
              const emphasis = rankEmphasis(row.rank, placing);
              const range = ranges.get(group);
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
                    <div className={emphasis ? `list-row static mmr-row band ${emphasis}` : "list-row static mmr-row"}>
                      <span className={emphasis ? `rank ${emphasis}` : "rank"}>
                        {!placing && ROW_CROWN_PX[row.rank] && <Crown size={ROW_CROWN_PX[row.rank]!} />}
                        {row.rank}
                      </span>
                      <span className="mmr-who">
                        <button type="button" className="link mmr-name" onClick={() => props.openPerson(row.participantId)}>
                          {row.name}
                        </button>
                        {standing?.title && <TitleBadge name={standing.title} grade={standing.grade} />}
                      </span>
                      <span className="mmr-score">
                        {placing ? (
                          <>
                            <span className="mmr-placing">
                              배치 {row.games}/{placementGames}
                            </span>
                            <Meter value={row.games / placementGames} tone="share" small />
                          </>
                        ) : (
                          rating && (
                            <>
                              <span className="mmr-score-line">
                                <strong className="mmr-value">{shownRating(rating.rating)}</strong>
                                <RatingTierBadge rating={rating.rating} placed />
                                <DeltaChip delta={rating.delta10} />
                              </span>
                              {range && (
                                <span className={emphasis ? `mmr-bar ${emphasis}` : "mmr-bar"}>
                                  <Meter value={mmrBarShare(rating.rating, range)} small />
                                </span>
                              )}
                            </>
                          )
                        )}
                      </span>
                      <span className="mmr-meta">
                        <span>
                          {row.games}경기 · <span className={rateTier(row.wins, row.games)}>{rateText(row.wins, row.games)}</span>
                          {!placing && rating && <> · 최고 {shownRating(rating.peak)}</>}
                        </span>
                        <FormDots
                          results={recentResults(forms.get(row.participantId), RATING_RECENT_GAMES)}
                          label={`최근 ${RATING_RECENT_GAMES}경기(왼쪽이 최근)`}
                        />
                      </span>
                      <button
                        type="button"
                        className="mmr-toggle"
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
        )}
        <Help label="MMR과 순서">
          MMR은 상대 팀의 평균 MMR을 감안해 승패마다 오르내리는 점수예요(시작 {ratingOptions.start}). 3연승·3연패부터 변화 폭이 커져요(최대 1.5배). {RATING_TIER_HELP} 순서는{" "}
          {RANKING_GROUP_LABEL[0]} → 배치 완료 → 배치 진행 중이고, 묶음 안에서는 MMR → 승률 → 경기 수 → 이름입니다.
          시상대는 {RANKING_GROUP_LABEL[0]}인 사람의 1~3위예요. 막대는 같은 묶음의 가장 낮은 MMR부터 가장 높은 MMR까지를
          견준 길이입니다. 배치 진행 중({placementGames}경기 미만)은 점수가 크게 흔들려 MMR 대신 배치 판수를 보여 주고
          요약 타일·강조에서도 뺍니다. 이름을 검색해도 순위 숫자는 그대로예요. ▾를 누르면 그 사람의 MMR 추이가 펼쳐집니다.
        </Help>
      </section>
    </div>
  );
}

/** 최근 10경기 변화 칩: 오르면 초록 "▲ 28", 내리면 빨강 "▼ 7", 그대로면 회색 "–". 화살표로도 구분한다(색만 쓰지 않게). */
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

function PodiumCell(props: {
  row: RankedRow;
  rating: PersonRating | undefined;
  standing: ShownStanding | undefined;
  openPerson: (id: string) => void;
}) {
  const { row, rating, standing } = props;
  return (
    <li className={`podium-cell medal-${row.rank} mmr-enter`} style={enterStyle(row.rank - 1)}>
      <span className="podium-rank">
        <Crown size={PODIUM_CROWN_PX[row.rank]!} />
        {row.rank}
        <span className="sr-only">위</span>
      </span>
      <button type="button" className="link podium-name" onClick={() => props.openPerson(row.participantId)}>
        {row.name}
      </button>
      {standing?.title && <TitleBadge name={standing.title} grade={standing.grade} />}
      {rating && (
        <>
          <strong className="podium-mmr">
            {shownRating(rating.rating)}
            <span className="podium-unit"> MMR</span>
          </strong>
          <RatingTierBadge rating={rating.rating} placed />
          <DeltaChip delta={rating.delta10} />
        </>
      )}
    </li>
  );
}

function HighlightTile(props: {
  label: string;
  entry: RankingHighlight | null;
  value: (rating: PersonRating) => string;
  tone?: "up";
}) {
  const { entry } = props;
  return (
    <div>
      <dt className="tile-label">{props.label}</dt>
      {entry ? (
        <dd>
          <span className="mmr-tile-name">{entry.row.name}</span>
          <strong className={props.tone === "up" ? "mmr-tile-value mmr-delta up" : "mmr-tile-value"}>
            {props.value(entry.rating)}
          </strong>
        </dd>
      ) : (
        <dd>
          <span className="mmr-tile-value">—</span>
        </dd>
      )}
    </div>
  );
}
