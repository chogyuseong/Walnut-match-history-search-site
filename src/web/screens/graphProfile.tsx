// 그래프 분석에서 플레이어를 고르면 요약 타일 자리에 나오는 그 사람 묶음(PlayerProfile).
import { useMemo } from "react";
import { cumulativeTrend, resultsOf, streakOf, streakText } from "../../shared/insights";
import { placementGamesOf, SMALL_SAMPLE, type playerLineMatrix } from "../../shared/stats";
import type { Snapshot } from "../../shared/types";
import { personUpsets, UPSET_MMR_GAP } from "../../shared/upset";
import type { attendanceReport } from "../../shared/attendance";
import { shownRating, type computeRatings } from "../../shared/rating";
import { playerCommentary } from "../../shared/playerCommentary";
import { lineShape, ratingRank } from "../../shared/graphs";
import { percentText, rateHueText, type ShownStanding } from "../format";
import { FormDots, RateRing, RatingTierBadge, TitleBadge, TrendLine } from "../screenKit";
import type { useExpectations } from "../matchCard";
import { LineShapeChart } from "./graphFigures";
import { CommentaryCard } from "./graphCommentary";

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
export function PlayerProfile(props: {
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
  openMatch: (id: string) => void;
  clear: () => void;
}) {
  const { snapshot, participantId: id, scoped, standing, openMatch } = props;
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
      playerCommentary({
        scoped,
        participantId: id,
        nameOf,
        ratings,
        expectations,
        attendance,
        cumulative,
        placementGames,
        timeZone: props.snapshot.group.timezone,
      }),
    [scoped, id, nameOf, ratings, expectations, attendance, cumulative, placementGames, props.snapshot.group.timezone],
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
              <p className={`summary-line ${rateHueText(wins, results.length)}`}>{recordLine(wins, results.length)}</p>
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
            <p className="hint" title={`이변 승: 팀 평균 MMR이 ${UPSET_MMR_GAP}점 이상 낮은 팀으로 이긴 경기`}>
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
      <CommentaryCard notes={notes} snapshot={snapshot} openMatch={openMatch} />
    </section>
  );
}
