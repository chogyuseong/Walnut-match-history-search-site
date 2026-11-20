// 그래프 분석의 "섞기 공정성(모임 전체)" 구역. 고른 플레이어와 상관없이 늘 모임 전체다.
// 판정은 경기 직전 팀 평균 MMR 차(누적, src/shared/upset.ts), 세는 경기는 고른 범위다.
import { fractionPercent, ratePercent } from "../../shared/stats";
import {
  BALANCED_MMR_GAP,
  FAIRNESS_GOOD,
  FAIRNESS_MIN_GAMES,
  FAIRNESS_OK,
  fairnessVerdict,
  LOPSIDED_MMR_GAP,
  UPSET_MMR_GAP,
  type FairnessVerdict,
  type fairnessReport,
} from "../../shared/upset";
import { shownRating } from "../../shared/rating";
import { InfoTip } from "../screenKit";
import { Meter } from "../rateMeters";

/**
 * 판정 한 줄 문구. 판정은 이 글로만 전한다(색으로 칠하지 않는다, styles.css 섞기 공정성 머리). 구간을 숫자로만 쓴다(2026-11-10 F5:
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
/**
 * 평균 MMR 차 미터가 가득 차는 값(점). 예전 기준(예상 25%p 치우침 = 75%)과 같은 선: 400 × log10(0.75 / 0.25) ≈ 190.8 → 191.
 * 실제 모임은 보통 20~85점(예전 3~12%p)이라 눈금이 너무 짧아지지 않게 잡았다.
 */
const FAIR_GAP_FULL = 191;

export function FairnessSection({ fairness }: { fairness: ReturnType<typeof fairnessReport> }) {
  const verdict = fairnessVerdict(fairness);
  return (
    <section className="graph-summary" aria-label="섞기 공정성(모임 전체)">
      <h2>
        섞기 공정성(모임 전체){" "}
        <InfoTip label="섞기 공정성">
          섞기 공정성은 경기 직전 두 팀의 평균 MMR 차로 봐요. 모든 모임이 같은 점수 기준이에요. 열 명 모두 배치 중인
          경기는 MMR이 의미가 적어 빼요. 균형 경기는 차가 {BALANCED_MMR_GAP}점 이내, 많이 치우침은 {LOPSIDED_MMR_GAP}점
          넘게 벌어진 경기, 이변은 {UPSET_MMR_GAP}점 이상 낮은 팀이 이긴 경기예요. 예상 우세 팀은 평균 MMR이 높은
          팀이에요.
        </InfoTip>
      </h2>
      {fairness.games < FAIRNESS_MIN_GAMES ? (
        <p className="hint">경기가 더 쌓이면 보여요(판정할 수 있는 경기 {fairness.games}/{FAIRNESS_MIN_GAMES}).</p>
      ) : (
        <>
          {/* 머리: 큰 숫자(균형 경기 비율) + 한 줄 판정(fairnessVerdict good·ok·poor의 글). */}
          <div className="fair-head">
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
                판정한 {fairness.games}경기 중 {fairness.balanced}경기가 팀 평균 MMR 차 {BALANCED_MMR_GAP}점 이내였어요.
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
              균형 {BALANCED_MMR_GAP}점 이내
            </li>
            <li>
              <i className="fair-seg-slight" />
              조금 치우침 ~{LOPSIDED_MMR_GAP}점
            </li>
            <li>
              <i className="fair-seg-lopsided" />
              많이 치우침
            </li>
          </ul>
          {/* 보조 타일 3칸: 미터로 크기를 보이게 한다. 평균 MMR 차는 FAIR_GAP_FULL(191점)을 가득으로 본다. */}
          <dl className="ps-tiles season-tiles fair-tiles">
            <div className="fair-tile-skew">
              <dt className="tile-label">평균 MMR 차</dt>
              <dd className="season-stat">
                {shownRating(fairness.avgGap)}
                <span className="season-unit">점</span>
              </dd>
              <Meter value={fairness.avgGap / FAIR_GAP_FULL} tone="share" small />
            </div>
            <div className="fair-tile-favorite">
              <dt className="tile-label">예상 우세 팀 승률</dt>
              <dd className="season-stat">
                {fairness.favoriteGames > 0 ? ratePercent(fairness.favoriteWins, fairness.favoriteGames) : "—"}
                {fairness.favoriteGames > 0 && <span className="season-unit">%</span>}
              </dd>
              {fairness.favoriteGames > 0 && (
                <Meter value={fairness.favoriteWins / fairness.favoriteGames} tone="share" mid small />
              )}
            </div>
            <div className="fair-tile-skew">
              <dt className="tile-label">이변 경기</dt>
              <dd className="season-stat">
                {fairness.upsets}
                <span className="season-unit">경기</span>
              </dd>
              <Meter value={fairness.upsets / fairness.games} tone="share" small />
            </div>
          </dl>
          <p className="hint">
            경기 직전 팀 평균 MMR 차(누적) 기준이라 모든 모임에 같은 뜻이에요. 이변은 평균 MMR이 {UPSET_MMR_GAP}점 이상 낮은 팀이 이긴 경기예요.
          </p>
        </>
      )}
    </section>
  );
}
