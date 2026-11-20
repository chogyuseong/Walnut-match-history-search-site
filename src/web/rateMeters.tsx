// 승패를 보여 주는 작은 그림: 최근 승패 글자(FormDots), 가로 막대(Meter·RateBar·WinLossBar), 승률 고리(RateRing).
// 요약·랭킹·검색·개인 통계·비교·그래프가 쓴다.
import { ratePercent, SMALL_SAMPLE } from "../shared/stats";
import { heatClass, rateHueClass, rateTier } from "./format";

/**
 * 최근 승패. 최근 경기가 왼쪽이고, 칸 없이 "승패승" 글자로 쓴다(승은 승리 글자색, 패는 패배 글자색).
 * 색만이 아니라 글자로도 구분하고, 읽는 사람에게는 "최근 5경기 승 패 승…"처럼 읽힌다.
 * 2026-11-17 전에는 색칸이었고 요약 화면 상위 5명만 글자였다. 칸이 줄마다 10개씩 쌓여 랭킹 화면에서 가장 시끄러워 글자로 통일했다.
 */
export function FormDots(props: { results: readonly boolean[]; label?: string }) {
  if (props.results.length === 0) return null;
  return (
    <span className="form-dots">
      <span className="sr-only">{props.label ?? `최근 ${props.results.length}경기`}</span>
      {props.results.map((won, i) => (
        <span key={i} className={won ? "form-dot win" : "form-dot loss"}>
          {won ? "승" : "패"}
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 개인 통계·검색의 작은 그림. 그림은 보조이고 정확한 값은 언제나 옆의 숫자·글자다.
// 그래서 그림은 화면 읽기 프로그램에 읽히지 않게 숨긴다(aria-hidden). 색은 그래프 화면의 .viz-root 값을 쓴다.

export type MeterTone = "rate" | "blue" | "red" | "share";

/**
 * 가로 막대 하나. value는 0~1.
 * tone: rate(승률) · blue/red(진영 색) · share(비중, 중립색). muted면 색 없이 속 빈 막대로 그린다.
 * heat: 승률 3단 클래스(heatClass). 승률 막대만 준다.
 * mid: 50% 기준선.
 */
export function Meter(props: {
  value: number;
  tone?: MeterTone;
  heat?: string;
  mid?: boolean;
  muted?: boolean;
  small?: boolean;
}) {
  const width = Math.max(0, Math.min(1, props.value)) * 100;
  const tone = props.muted ? "muted" : (props.tone ?? "rate");
  const heat = !props.muted && tone === "rate" && props.heat ? ` ${props.heat}` : "";
  return (
    <span className={props.small ? "meter meter-sm viz-root" : "meter viz-root"} aria-hidden="true">
      <span className={`meter-fill tone-${tone}${heat}`} style={{ width: `${width}%` }} />
      {props.mid && <span className="meter-mid" />}
    </span>
  );
}

/**
 * 승률 막대(50% 기준선 포함). 기록이 없으면 빈 막대다.
 * 승률 막대는 승률 3단(heatClass: 높음(55% 이상) 강조색 · 45~54% 주요 글자 · 낮음 보조 글자)을 따르고,
 * SMALL_SAMPLE경기 미만이면 속 빈 막대로 그린다(rateTier·"자료 적음"과 같은 규칙).
 * 진영 막대(blue·red)는 진영을 가리키는 색이라 표본·승률과 관계없이 진영 색을 쓴다.
 */
export function RateBar(props: {
  wins: number;
  games: number;
  tone?: MeterTone;
  small?: boolean;
  /** 승률 3단 대신 승률 여섯 색(rateHueClass, 그래프 분석·요약과 같다). 검색 결과가 쓴다. */
  hued?: boolean;
}) {
  const { wins, games } = props;
  const tone = props.tone ?? "rate";
  return (
    <Meter
      value={games === 0 ? 0 : wins / games}
      tone={tone}
      heat={tone === "rate" ? (props.hued ? rateHueClass(wins, games) : heatClass(wins, games)) : undefined}
      mid
      muted={tone === "rate" && games < SMALL_SAMPLE}
      small={props.small}
    />
  );
}

/** 승·패 비율 막대. 왼쪽이 승(승리 색 채움), 오른쪽이 패(패배 색 테두리만, 속 빈 막대). 가운데 50% 기준선. */
export function WinLossBar(props: { wins: number; losses: number }) {
  const { wins, losses } = props;
  if (wins + losses === 0) return <Meter value={0} mid />;
  return (
    <span className="wl-bar" aria-hidden="true">
      <span className="wl-win" style={{ flexGrow: wins }} />
      <span className="wl-loss" style={{ flexGrow: losses }} />
      <span className="meter-mid" />
    </span>
  );
}

/**
 * 승률 고리(도넛). 채운 호가 승률이고 아래쪽 눈금이 50%다. 가운데에 승률을 크게 적는다.
 * 호와 가운데 숫자는 승률 여섯 색(rateHueClass, 개인별 승률 막대와 같다). 5경기 미만은 색 없이.
 * 숫자는 바로 옆 요약 줄에도 그대로 있으므로 고리 전체를 화면 읽기에서 숨긴다.
 */
export function RateRing(props: { wins: number; games: number }) {
  const { wins, games } = props;
  if (games === 0) return null;
  const rate = wins / games;
  const R = 26;
  const C = 2 * Math.PI * R;
  const muted = games < SMALL_SAMPLE;
  return (
    <div className="ring viz-root" aria-hidden="true">
      <svg viewBox="0 0 68 68">
        <circle className="ring-track" cx="34" cy="34" r={R} />
        <circle
          className={muted ? "ring-fill tone-muted" : `ring-fill ${rateHueClass(wins, games) || heatClass(wins, games)}`}
          cx="34"
          cy="34"
          r={R}
          strokeDasharray={`${(rate * C).toFixed(2)} ${C.toFixed(2)}`}
          transform="rotate(-90 34 34)"
        />
        <line className="ring-mid" x1="34" x2="34" y1={34 + R - 7} y2={34 + R + 7} />
      </svg>
      <span className="ring-text">
        <strong className={muted ? rateTier(wins, games) : `rate ${rateHueClass(wins, games)}`}>{ratePercent(wins, games)}%</strong>
        <span>승률</span>
      </span>
    </div>
  );
}
