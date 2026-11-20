// 작은 추이 선 그래프 둘: 누적 승률 추이와 MMR 추이. 그래프 분석의 고른 플레이어 묶음(graphProfile.tsx)이 쓴다.
import type { ReactNode } from "react";
import { fractionPercent } from "../shared/stats";

/**
 * 추이 그래프의 틀: 왼쪽에 세로 눈금 세 개(위·가운데·아래), 아래에 가로 구간 숫자 세 개(처음·중간·끝).
 * SVG는 preserveAspectRatio="none"으로 늘어나므로 글자는 SVG 밖 HTML에 둔다. 눈금이 없으면 선의 높이가 어느 정도인지
 * 가늠할 수 없다는 피드백으로 넣었다.
 */
function TrendFrame(props: { yTicks: [string, string, string]; xTicks: [string, string, string]; children: ReactNode }) {
  return (
    <div className="trend-plot">
      <div className="trend-y" aria-hidden="true">
        {props.yTicks.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
      {props.children}
      <div className="trend-x" aria-hidden="true">
        {props.xTicks.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * 누적 승률 추이(작은 선 그래프). 그래프 화면의 .viz-root 색 변수를 쓴다.
 * 50% 기준선을 두고, 처음·끝 값은 글자로 함께 적는다.
 */
export function TrendLine(props: { points: readonly { game: number; rate: number }[] }) {
  const { points } = props;
  if (points.length < 2) return null;
  const W = 300;
  const H = 72;
  const last = points[points.length - 1]!;
  const first = points[0]!;
  // 세로축은 50%를 가운데에 두고 위아래를 같은 폭으로 잡는다(최소 ±20%p). 위아래 4px 여백.
  const spread = Math.min(0.5, Math.max(0.2, ...points.map((p) => Math.abs(p.rate - 0.5))) + 0.02);
  const x = (game: number) => ((game - first.game) / Math.max(1, last.game - first.game)) * W;
  const y = (rate: number) => 4 + ((0.5 + spread - rate) / (spread * 2)) * (H - 8);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.game).toFixed(1)},${y(p.rate).toFixed(1)}`).join("");
  const pct = (r: number) => `${fractionPercent(r)}%`;
  const midGame = Math.round((first.game + last.game) / 2);
  return (
    <figure className="trend trend-rate viz-root">
      <TrendFrame
        yTicks={[pct(0.5 + spread), "50%", pct(0.5 - spread)]}
        xTicks={[`${first.game}경기`, `${midGame}경기`, `${last.game}경기`]}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`누적 승률 추이: ${first.game}경기째 ${pct(first.rate)}에서 ${last.game}경기째 ${pct(last.rate)}, 위아래 끝 ${pct(0.5 + spread)} / ${pct(0.5 - spread)}`}
        >
          <rect x="0" y="0" width={W} height={H} className="trend-bg" />
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="trend-mid" vectorEffect="non-scaling-stroke" />
          <path d={path} className="trend-path" vectorEffect="non-scaling-stroke" />
        </svg>
      </TrendFrame>
      <figcaption className="trend-caption">
        <span>누적 승률 추이</span>
        <span>
          {first.game}경기째 {pct(first.rate)} → <strong>{last.game}경기째 {pct(last.rate)}</strong>
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * MMR 추이(작은 선 그래프). TrendLine과 같은 모양·클래스이고, 가운데 기준선이 시작값(모임 설정)이다.
 * 세로축은 시작값을 가운데에 두고 위아래를 같은 폭으로 잡는다(최소 ±50). 처음·끝 값은 글자로 함께 적는다.
 * points: 0경기째(시작값)부터. rating.ts ratingTrend의 결과.
 */
export function RatingTrendLine(props: { points: readonly { game: number; rating: number }[]; start: number }) {
  const { points } = props;
  if (points.length < 2) return null;
  const W = 300;
  const H = 72;
  const MID = props.start;
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const spread = Math.max(50, ...points.map((p) => Math.abs(p.rating - MID))) * 1.05;
  const x = (game: number) => ((game - first.game) / Math.max(1, last.game - first.game)) * W;
  const y = (rating: number) => 4 + ((MID + spread - rating) / (spread * 2)) * (H - 8);
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.game).toFixed(1)},${y(p.rating).toFixed(1)}`).join("");
  const n = (r: number) => String(Math.round(r));
  const at = (game: number) => (game === 0 ? "시작" : `${game}경기째`);
  const midGame = Math.round((first.game + last.game) / 2);
  return (
    <figure className="trend trend-rating viz-root">
      <TrendFrame
        yTicks={[n(MID + spread), String(MID), n(MID - spread)]}
        xTicks={[first.game === 0 ? "시작" : `${first.game}경기`, `${midGame}경기`, `${last.game}경기`]}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`MMR 추이: ${at(first.game)} ${n(first.rating)}에서 ${last.game}경기째 ${n(last.rating)}, 위아래 끝 ${n(MID + spread)} / ${n(MID - spread)}`}
        >
          <rect x="0" y="0" width={W} height={H} className="trend-bg" />
          <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="trend-mid" vectorEffect="non-scaling-stroke" />
          <path d={path} className="trend-path" vectorEffect="non-scaling-stroke" />
        </svg>
      </TrendFrame>
      <figcaption className="trend-caption">
        <span>MMR 추이</span>
        <span>
          {at(first.game)} {n(first.rating)} → <strong>{last.game}경기째 {n(last.rating)}</strong>
        </span>
      </figcaption>
    </figure>
  );
}
