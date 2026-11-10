import { Fragment, useMemo, useState, type CSSProperties } from "react";
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
  ratingTierOf,
} from "../../shared/rating";
import type { Snapshot } from "../../shared/types";
import { nameMap, rankClass, rateText, rateTier, standingsOf, type ShownStanding } from "../format";
import { FormDots, Help, Meter, RatingTierBadge, RatingTrendLine, TitleBadge } from "../ui";

/**
 * MMR 랭킹 화면(#/ranking, 조회 링크·예시 모임은 …/ranking). 결과 기반 MMR(rating.ts) 순위표를 묶음별로 그린다.
 * 위에서부터 1위 칸(50경기 이상 1위, 포인트 색으로 채운 칸) · 요약 타일 · 순위표. 순위표는 카드 하나에 줄 구분선만 두고,
 * 상위는 순위 숫자 색으로만 띄운다(format.ts rankClass: 1위 포인트 색 · 2위 은 · 3위 동 · 4~10위 본문 · 11위~ 흐림).
 * 줄마다 시작 MMR(모임 설정) 기준선에서 오른쪽(올랐다)·왼쪽(내렸다)으로 뻗는 막대를 둔다(2026-11-10 시안 "막대 순위표").
 * 데이터는 스냅숏의 경기에서 기기가 매번 계산한다(computeRatings · standingsOf · personForms). 범위 없이 모임 전체 누적이다.
 * 순서·묶음은 기록 화면 "소환사 랭킹"의 MMR 순과 같다(shared/ranking.ts → insights.rankAndSearch).
 */

/** 등장 효과를 차례로 늦추는 행 수. 그 아래 행은 10번째와 함께 나타난다(긴 목록이 오래 기다리지 않게). */
const ENTER_STAGGER_ROWS = 10;
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
  const scale = useMemo(
    () => mmrScale(ranking.ranked, table, placement, ratingOptions.start),
    [ranking, table, placement, ratingOptions.start],
  );
  // 1위 칸은 시상대 규칙(podiumOf: 누적 50경기 이상 묶음)의 1위만 세운다. 몇 판 안 한 사람이 맨 위 칸을 차지하지 않게.
  const leader = useMemo(
    () => podiumOf(ranking.ranked, placement).find((row) => row.rank === 1) ?? null,
    [ranking, placement],
  );
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
          {/* 흐린 글자 한 줄("실버 7 · 브론즈 10"). 가운뎃점은 CSS가 칸 사이에 넣는다. */}
          {tierCounts.map(({ tier, count }) => (
            <span key={tier.key} className="mmr-tier-count">
              {tier.short} {count}
            </span>
          ))}
        </p>
      )}

      {leader && (
        <LeaderBlock
          row={leader}
          rating={table.get(leader.participantId)}
          standing={placement.get(leader.participantId)}
          recent={recentResults(forms.get(leader.participantId), RATING_RECENT_GAMES)}
          openPerson={props.openPerson}
        />
      )}

      <section aria-label="랭킹 요약">
        <h2 className="sr-only">요약</h2>
        {/* 1위 칸이 있으면 1위 타일은 같은 내용이라 뺀다. */}
        <dl className={leader ? "ps-tiles mmr-tiles two" : "ps-tiles mmr-tiles"}>
          {!leader && (
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
          <ul className="list list-card mmr-list">
            {scale && <ScaleHead scale={scale} />}
            {ranking.shown.map((row, i) => {
              const rating = table.get(row.participantId);
              const standing = placement.get(row.participantId);
              const group = rankingGroup(placement, row.participantId);
              const prev = i > 0 ? rankingGroup(placement, ranking.shown[i - 1]!.participantId) : null;
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
                    <div className="list-row static mmr-row">
                      {/* 배치 진행 중은 순위가 높아 보여도 강조하지 않는다(점수가 아직 흔들린다). */}
                      <span className={rankClass(row.rank, placing)}>{row.rank}</span>
                      <span className="mmr-who">
                        <button type="button" className="link mmr-name" onClick={() => props.openPerson(row.participantId)}>
                          {row.name}
                        </button>
                        {standing?.title && <TitleBadge name={standing.title} grade={standing.grade} compact />}
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
                            <span className="mmr-score-line">
                              <strong className="mmr-value">{shownRating(rating.rating)}</strong>
                              <RatingTierBadge rating={rating.rating} placed />
                              <DeltaChip delta={rating.delta10} />
                            </span>
                          )
                        )}
                      </span>
                      {!placing && rating && scale && (
                        <StartBar rating={rating.rating} scale={scale} top={row.rank === 1} />
                      )}
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
          맨 위 칸은 {RANKING_GROUP_LABEL[0]}인 사람의 1위예요. 막대는 시작 {ratingOptions.start}을 세로 기준선으로 두고
          오른쪽은 그보다 오른 만큼, 왼쪽은 내린 만큼이며 양 끝은 순위표의 가장 낮은·높은 MMR입니다. 배치 진행 중({placementGames}경기 미만)은 점수가 크게 흔들려 MMR 대신 배치 판수를 보여 주고
          요약 타일·강조에서도 뺍니다. 이름을 검색해도 순위 숫자는 그대로예요. ▾를 누르면 그 사람의 MMR 추이가 펼쳐집니다.
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
 * 1위 칸: 포인트 색(--ih-brand-fill)으로 채운 칸에 이름·MMR·전적·최근 승패. 채운 바탕 위라 칭호·티어는 등급 색 이름표
 * 대신 글자로 쓰고, 최근 변동·승패 칸도 바탕 위 글자 색(--ih-on-brand-fill) 하나로 그린다(styles.css .mmr-leader).
 * 뒤의 큰 "1"은 꾸밈이라 읽지 않는다.
 */
function LeaderBlock(props: {
  row: RankedRow;
  rating: PersonRating | undefined;
  standing: ShownStanding | undefined;
  recent: boolean[];
  openPerson: (id: string) => void;
}) {
  const { row, rating, standing } = props;
  const tier = rating ? ratingTierOf(rating.rating, true) : null;
  return (
    <section aria-label="1위" className="mmr-leader mmr-enter">
      <span className="mmr-leader-ghost" aria-hidden="true">
        1
      </span>
      <p className="mmr-leader-kicker">
        1위{standing?.title && <> · {standing.title}</>}
        {tier && <> · {tier.name}</>}
      </p>
      <div className="mmr-leader-main">
        <button type="button" className="link mmr-leader-name" onClick={() => props.openPerson(row.participantId)}>
          {row.name}
        </button>
        {rating && (
          <span className="mmr-leader-score">
            <strong className="mmr-leader-mmr">
              {shownRating(rating.rating)}
              <span className="sr-only"> MMR</span>
            </strong>
            <DeltaChip delta={rating.delta10} />
          </span>
        )}
      </div>
      <div className="mmr-leader-foot">
        <span>
          {row.games}경기 · 승률 {rateText(row.wins, row.games)}
          {rating && <> · 최고 {shownRating(rating.peak)}</>}
        </span>
        <FormDots results={props.recent} label={`최근 ${RATING_RECENT_GAMES}경기(왼쪽이 최근)`} />
      </div>
    </section>
  );
}

/**
 * 순위표 맨 위의 눈금 줄: 왼쪽 끝 · 시작값 · 오른쪽 끝 MMR. 줄(.mmr-row)과 같은 칸 배치를 써서 막대 칸 바로 위에 선다.
 * 숫자는 막대마다 붙인 대체 글자(StartBar)가 이미 읽어 주므로 읽지 않는다. 시작값이 끝에 가까우면 끝 숫자와 겹쳐 끝 숫자를 뺀다.
 */
function ScaleHead(props: { scale: MmrScale }) {
  const { scale } = props;
  const at = divergingBar(scale.start, scale).left;
  return (
    <li className="mmr-axis" role="presentation" aria-hidden="true">
      <div className="list-row static mmr-row">
        <span className="mmr-axis-scale" style={{ "--at": at } as CSSProperties}>
          {at > 0.2 && <span className="mmr-axis-lo">{shownRating(scale.lo)}</span>}
          <span className="mmr-axis-start">시작 {shownRating(scale.start)}</span>
          {at < 0.8 && <span className="mmr-axis-hi">{shownRating(scale.hi)}</span>}
        </span>
      </div>
    </li>
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
