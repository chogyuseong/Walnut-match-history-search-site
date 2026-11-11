import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  WEEKDAY_LABEL,
  type ActivityCalendar,
  type RankRace,
  type ShapeAxis,
  type StoryCard,
} from "../../shared/graphs";
import { ratePercent, SMALL_SAMPLE } from "../../shared/stats";
import { POSITION_LABEL } from "../format";
import { RoleIcon } from "../screenKit";

/**
 * 그래프 분석 화면(Graphs.tsx)의 그림 부품(2026-11-09): 이야기 띠 · 순위 변동 · 라인 모양 · 활동 달력 · 승·패 띠.
 * 계산은 하지 않는다. 값은 모두 src/shared/graphs.ts가 스냅숏에서 만든 결과를 Graphs.tsx가 넘겨준다.
 * 색은 styles.css의 .viz-root 변수(--viz-*, --cat)만 쓴다(테마 3종이 같은 코드로 바뀐다).
 * 글자는 늘 본문 색이고 색 표시는 곁의 선·점이 맡는다. 색만으로 구분하지 않게 이름표·굵기·점선을 함께 쓴다.
 */

/** 폭을 재기 전 첫 그림의 폭(px). 실제 폭을 재면 곧 바뀐다. */
const FALLBACK_WIDTH = 640;
/** 이보다 좁게는 그리지 않는다(320px 폰의 카드 안쪽 폭 근처). 더 좁으면 이름표가 잘린다. */
const MIN_WIDTH = 240;

/**
 * 요소의 실제 폭(px). SVG를 viewBox로 늘이면 폰에서 글자가 반쯤으로 작아지므로, 재 둔 폭 그대로 그린다.
 * 바꿀 때 주의: ResizeObserver가 없는 환경(테스트 등)에서는 처음 잰 폭만 쓴다.
 */
function useWidth<T extends HTMLElement>(fallback: number): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setWidth(Math.max(MIN_WIDTH, Math.round(el.clientWidth)));
    read();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// ---------------------------------------------------------------------------
// 이야기 띠: 카드 2~4장. 누르면 카드의 첫 사람을 "고른 플레이어"로(Graphs의 choosePlayer).

export function StoryStrip(props: { cards: StoryCard[]; picked: string; onPick: (id: string) => void }) {
  if (props.cards.length === 0) return null;
  return (
    <section className="story-strip" aria-label="이번 범위 이야기">
      <h2 className="sr-only">이번 범위 이야기</h2>
      <ul>
        {props.cards.map((card) => {
          const picked = props.picked !== "" && card.people.includes(props.picked);
          return (
            <li key={card.kind}>
              <button
                type="button"
                className={`story-card kind-${card.kind}${picked ? " picked" : ""}`}
                title="누르면 이 사람을 플레이어로 골라요"
                onClick={() => props.onPick(card.people[0]!)}
              >
                <span className="tile-label">{card.label}</span>
                <strong>{card.text}</strong>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 순위 변동
//
// 좌표계: SVG 한 칸 = 화면 1px(viewBox = 0 0 폭 높이, 재 둔 폭 그대로). 원점은 왼쪽 위.
// 가로: 왼쪽 여백(순위 눈금 글자) ~ 오른쪽 여백(끝 이름표) 사이에 시점을 고르게 놓는다(첫 시점이 왼쪽 끝).
// 세로: 위 여백 아래가 1위, 아래 여백(시점 이름) 위가 가장 큰 순위. 순위가 같으면 같은 높이다.

/** 마지막 순위 상위 몇 명에게 범주색(.cat-1~5)을 줄지. 늘리면 styles.css에 --viz-cat-6… 도 더해야 한다. */
export const RACE_COLORED = 5;
/** 그림 높이(px). 사람이 30명을 넘으면 선 간격이 7px 아래로 좁아져 구별이 어렵다. */
const RACE_H = 260;
/** 왼쪽 여백: "21위" 같은 눈금 글자 자리. */
const RACE_LEFT = 30;
/** 오른쪽 여백: 끝 이름표("12 느린시계") 자리. 좁은 화면은 이름을 줄일 수 없어 여백을 덜 준다. */
const RACE_RIGHT = 96;
const RACE_RIGHT_NARROW = 68;
/** 이 폭(px)보다 좁으면 좁은 오른쪽 여백을 쓴다. */
const RACE_NARROW_BELOW = 420;
const RACE_TOP = 10;
/** 아래 여백: 첫·끝 시점 이름 한 줄. */
const RACE_BOTTOM = 24;
/** 시점 이름의 바닥선 위치(그림 아래 끝에서 위로). */
const RACE_AXIS_BASELINE = 6;
/** 눈금 글자와 그림 사이 틈. */
const RACE_TICK_GAP = 6;
/** 끝 이름표 사이 최소 세로 간격(글자 12px + 1). 줄이면 이름표가 겹친다. */
const RACE_LABEL_GAP = 13;
/** 이름표가 아래 여백까지 내려가도 되는 정도(시점 이름과 겹치지 않는 선). */
const RACE_LABEL_OVERHANG = 4;
/** 끝점 → 이름표 잇는 짧은 선의 시작·끝(끝점에서 오른쪽으로), 그리고 글자 시작. */
const RACE_TIE_FROM = 4;
const RACE_TIE_TO = 10;
const RACE_NAME_X = 12;
/** 끝점 반지름: 고른 사람은 한 단계 크게. */
const RACE_DOT = 3;
const RACE_DOT_PICKED = 4;
/** 글자 세로 가운데 맞춤(SVG text의 dy). */
const TEXT_MIDDLE = "0.32em";

/**
 * MMR 순위 변동 선 그림. race는 rankRace() 결과, picked는 고른 플레이어 ID("" 가능).
 * 선 색: 마지막 상위 RACE_COLORED명만 범주색, 나머지 회색, 고른 사람은 굵게(상위 밖이면 본문 색).
 * 마우스를 올린 선(CSS :hover)과 누른 선(focus 상태, 터치용)만 진하게 보인다. 빈 곳을 누르면 풀린다.
 */
export function RankRaceChart(props: { race: RankRace; nameOf: (id: string) => string; picked: string }) {
  const { race, nameOf, picked } = props;
  const [ref, W] = useWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const [focus, setFocus] = useState<string | null>(null);
  const n = race.labels.length;
  const right = W < RACE_NARROW_BELOW ? RACE_RIGHT_NARROW : RACE_RIGHT;
  const plotW = W - RACE_LEFT - right;
  const plotH = RACE_H - RACE_TOP - RACE_BOTTOM;
  const x = (i: number) => RACE_LEFT + (n <= 1 ? plotW : (i / (n - 1)) * plotW);
  const y = (rank: number) => RACE_TOP + (race.maxRank <= 1 ? 0 : ((rank - 1) / (race.maxRank - 1)) * plotH);

  // 색은 사람을 따른다(순위가 바뀌어도 같은 사람은 같은 색). race.series가 마지막 순위순이라 앞 다섯이 상위다.
  const colored = new Map(
    race.series
      .filter((s) => s.finalRank !== null)
      .slice(0, RACE_COLORED)
      .map((s, i) => [s.participantId, i + 1]),
  );
  // 배치 전(null) 시점은 선을 끊는다. 배치는 되돌아가지 않으므로 실제로는 앞쪽만 비어 있다.
  const pathOf = (ranks: (number | null)[]) => {
    let d = "";
    let pen = false;
    ranks.forEach((r, i) => {
      if (r === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(r).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  // 그리는 순서 = 쌓이는 순서: 회색 → 범주색 → 고른 사람(맨 위).
  const drawn = race.series
    .filter((s) => s.ranks.some((r) => r !== null))
    .sort((a, b) => {
      const w = (id: string) => (id === picked ? 2 : colored.has(id) ? 1 : 0);
      return w(a.participantId) - w(b.participantId);
    });

  // 끝 이름표: 상위 RACE_COLORED명 + 고른 사람. 위에서부터 겹치면 아래로 밀고, 바닥을 넘으면 아래에서부터 위로 되민다.
  const labels = race.series
    .filter((s) => s.finalRank !== null && (colored.has(s.participantId) || s.participantId === picked))
    .map((s) => ({ id: s.participantId, rank: s.finalRank!, y: y(s.finalRank!) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i]!.y = Math.max(labels[i]!.y, labels[i - 1]!.y + RACE_LABEL_GAP);
  const floor = RACE_H - RACE_BOTTOM + RACE_LABEL_OVERHANG;
  for (let i = labels.length - 1; i >= 0; i--) {
    const limit = i === labels.length - 1 ? floor : labels[i + 1]!.y - RACE_LABEL_GAP;
    labels[i]!.y = Math.min(labels[i]!.y, limit);
  }

  const leader = race.series[0];
  // 눈금: 1위 · 가운데 · 꼴찌(같은 값은 하나로).
  const ticks = [...new Set([1, Math.ceil(race.maxRank / 2), race.maxRank])].filter((r) => r >= 1);
  const pickedSeries = race.series.find((s) => s.participantId === picked);
  const aria =
    `MMR 순위 변동, ${n}개 시점(${race.unit === "day" ? "모임 날" : "경기"} 단위). ` +
    (leader?.finalRank ? `마지막 1위 ${nameOf(leader.participantId)}. ` : "") +
    (pickedSeries?.finalRank ? `${nameOf(picked)} 마지막 ${pickedSeries.finalRank}위.` : "");

  return (
    <div ref={ref} className="race-wrap">
      <svg
        className={focus ? "race has-focus" : "race"}
        width={W}
        height={RACE_H}
        viewBox={`0 0 ${W} ${RACE_H}`}
        role="img"
        aria-label={aria}
        onClick={(e) => {
          if (e.target === e.currentTarget) setFocus(null);
        }}
      >
        {ticks.map((r) => (
          <g key={r}>
            <line className="race-grid" x1={RACE_LEFT} x2={RACE_LEFT + plotW} y1={y(r)} y2={y(r)} />
            <text className="race-axis" x={RACE_LEFT - RACE_TICK_GAP} y={y(r)} dy={TEXT_MIDDLE} textAnchor="end">
              {r}위
            </text>
          </g>
        ))}
        <text className="race-axis" x={RACE_LEFT} y={RACE_H - RACE_AXIS_BASELINE}>
          {race.labels[0]}
        </text>
        <text className="race-axis" x={RACE_LEFT + plotW} y={RACE_H - RACE_AXIS_BASELINE} textAnchor="end">
          {race.labels[n - 1]}
        </text>
        {/* 넓은 투명 선은 누르기 쉬운 자리. */}
        {drawn.map((s) => {
          const id = s.participantId;
          const d = pathOf(s.ranks);
          const cat = colored.get(id);
          const cls = [
            "race-series",
            cat ? `cat-${cat}` : "rest",
            id === picked ? "picked" : "",
            id === focus ? "focused" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <g key={id} className={cls} onClick={() => setFocus((f) => (f === id ? null : id))}>
              <title>
                {nameOf(id)}
                {s.finalRank ? ` · 마지막 ${s.finalRank}위` : ""}
              </title>
              <path className="race-hit" d={d} />
              <path className="race-line" d={d} />
            </g>
          );
        })}
        {/* 이름표는 겹치지 않게 옮긴 높이(l.y), 끝점은 실제 순위 높이다. */}
        {labels.map((l) => {
          const s = race.series.find((v) => v.participantId === l.id)!;
          const lastIndex = s.ranks.length - 1;
          const cat = colored.get(l.id);
          const cls = ["race-label", cat ? `cat-${cat}` : "rest", l.id === picked ? "picked" : ""].filter(Boolean).join(" ");
          const ex = x(lastIndex);
          const ey = y(l.rank);
          return (
            <g key={l.id} className={cls}>
              <circle className="race-end" cx={ex} cy={ey} r={l.id === picked ? RACE_DOT_PICKED : RACE_DOT} />
              <line className="race-tie" x1={ex + RACE_TIE_FROM} x2={ex + RACE_TIE_TO} y1={ey} y2={l.y} />
              <text className="race-name" x={ex + RACE_NAME_X} y={l.y} dy={TEXT_MIDDLE}>
                {l.rank} {nameOf(l.id)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 라인 모양(오각형)
//
// 좌표계: viewBox 0 0 RADAR RADAR(정사각형). 상자 폭에 맞춰 늘어난다(정사각형이라 모양은 그대로).
// 중심 (RADAR/2, RADAR/2), 축 끝 반지름 RADAR_R. 축 0(탑)이 위, 그다음 시계 방향으로 정글·미드·원딜·서폿.
// 축 이름표는 SVG 밖 HTML(.radar-label)로 % 위치에 둔다: 그래야 글자가 늘어나지 않고 RoleIcon을 그대로 쓸 수 있다.

export interface ShapeEntry {
  key: string;
  label: string;
  axes: ShapeAxis[];
  /** 범주색 칸: 1(고른 사람·모임 전체), 2(비교할 사람, 점선). */
  slot: 1 | 2;
}

const RADAR = 300;
/** 축 끝 반지름. 남는 (RADAR/2 − RADAR_R)는 이름표 자리다. 키우면 이름표가 상자 밖으로 나간다. */
const RADAR_R = 100;
/** 축 끝에서 이름표 가운데까지 거리. */
const RADAR_LABEL_OUT = 30;
const RADAR_CENTER = RADAR / 2;
const RADAR_AXES = 5;
/** 격자 눈금(축 길이 비율). 승률 보기에서는 33% · 67% · 100%. */
const RADAR_GRID = [1 / 3, 2 / 3, 1];
const RADAR_DOT = 4;

/** 축 i의 반지름 r 지점(SVG 좌표). 첫 축이 위(−90°)다. */
function polar(i: number, r: number): [number, number] {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / RADAR_AXES;
  return [RADAR_CENTER + r * Math.cos(a), RADAR_CENTER + r * Math.sin(a)];
}

/** 축 이름표의 값 글자. 0경기면 "—"(0%로 쓰면 못한 것처럼 보인다). */
function valueText(axis: ShapeAxis, mode: "rate" | "games"): string {
  if (axis.games === 0) return "—";
  return mode === "rate" ? `${ratePercent(axis.wins, axis.games)}%` : `${axis.games}경기`;
}

/**
 * 오각형 하나 또는 둘(비교). entries는 lineShape() 결과에 이름·색 칸을 붙인 것.
 * 승률 보기에서 weak(5경기 미만) 점은 속이 빈 흐린 점이고 값 글자도 흐리다. small은 프로필 묶음용 작은 크기.
 */
export function LineShapeChart(props: { entries: ShapeEntry[]; mode: "rate" | "games"; small?: boolean }) {
  const { entries, mode } = props;
  if (entries.length === 0) return null;
  const ring = (f: number) =>
    Array.from({ length: RADAR_AXES }, (_, i) => polar(i, RADAR_R * f).map((v) => v.toFixed(1)).join(",")).join(" ");
  const aria =
    `라인 모양(${mode === "rate" ? "승률" : "경기 수"}). ` +
    entries
      .map((e) => `${e.label}: ${e.axes.map((a) => `${POSITION_LABEL[a.position]} ${valueText(a, mode)}`).join(", ")}`)
      .join(". ");
  return (
    <figure className={props.small ? "radar small" : "radar"}>
      <div className="radar-box">
        <svg viewBox={`0 0 ${RADAR} ${RADAR}`} role="img" aria-label={aria}>
          {RADAR_GRID.map((f) => (
            <polygon key={f} className="radar-grid" points={ring(f)} />
          ))}
          {Array.from({ length: RADAR_AXES }, (_, i) => {
            const [ex, ey] = polar(i, RADAR_R);
            return <line key={i} className="radar-spoke" x1={RADAR_CENTER} y1={RADAR_CENTER} x2={ex} y2={ey} />;
          })}
          {entries.map((e) => {
            // 값이 0~1 밖이면 잘라 그린다.
            const corners = e.axes.map((axis, i) => ({ axis, at: polar(i, RADAR_R * Math.max(0, Math.min(1, axis.value))) }));
            return (
              <g key={e.key} className={`radar-shape cat-${e.slot}`}>
                <polygon className="radar-area" points={corners.map((c) => c.at.map((v) => v.toFixed(1)).join(",")).join(" ")} />
                {corners.map(({ axis, at: [px, py] }, i) => {
                  const faded = axis.weak && mode === "rate";
                  return (
                    <circle key={i} className={faded ? "radar-dot weak" : "radar-dot"} cx={px} cy={py} r={RADAR_DOT}>
                      <title>
                        {e.label} {POSITION_LABEL[axis.position]}: {valueText(axis, mode)} ({axis.games}경기)
                        {faded && axis.games > 0 ? ` · ${SMALL_SAMPLE}경기 미만이라 안쪽으로 당김` : ""}
                      </title>
                    </circle>
                  );
                })}
              </g>
            );
          })}
        </svg>
        {entries[0]!.axes.map((a, i) => {
          const [lx, ly] = polar(i, RADAR_R + RADAR_LABEL_OUT);
          return (
            <span
              key={a.position}
              className="radar-label"
              style={{ left: `${(lx / RADAR) * 100}%`, top: `${(ly / RADAR) * 100}%` }}
            >
              <span className="radar-pos">
                <RoleIcon position={a.position} />
                {POSITION_LABEL[a.position]}
              </span>
              {entries.map((e) => {
                const axis = e.axes[i]!;
                return (
                  <span key={e.key} className={axis.weak && mode === "rate" ? "radar-value weak" : "radar-value"}>
                    {entries.length > 1 && <span className={`radar-key cat-${e.slot}`} aria-hidden="true" />}
                    {valueText(axis, mode)}
                  </span>
                );
              })}
            </span>
          );
        })}
      </div>
      {/* 한 사람일 때는 제목이 이름을 말하므로 범례가 없다. */}
      {entries.length > 1 && (
        <figcaption className="legend">
          {entries.map((e) => (
            <span key={e.key} className="radar-legend">
              <span className={`radar-key cat-${e.slot}`} aria-hidden="true" />
              {e.label}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// 활동 달력
//
// 좌표계: SVG 한 칸 = 화면 1px(늘이지 않음). 열 = 주(왼쪽이 오래된 주), 행 = 요일(위가 월요일).
// 왼쪽 CAL_LEFT는 요일 글자, 위 CAL_TOP은 월 글자 자리. 폭이 카드보다 넓으면 .cal-scroll이 가로로 스크롤한다
// (화면에서 가로 스크롤을 허용하는 유일한 그림).

/** 칸 한 변(px). 줄이면 1년(53주) 달력이 폰에서 덜 넘치지만 누르기 어려워진다. */
const CELL = 12;
const CELL_GAP = 3;
const STEP = CELL + CELL_GAP;
/** 요일 글자("월") 자리. */
const CAL_LEFT = 22;
/** 월 글자("5월") 자리. */
const CAL_TOP = 16;
/** 월 글자 바닥선. */
const CAL_MONTH_BASELINE = 10;
/** 요일 글자 바닥선을 칸 아래 끝에서 올리는 정도. */
const CAL_DAY_RAISE = 2;
const CELL_RADIUS = 2;
/** 요일 글자를 붙이는 행: 월·수·금(다 쓰면 칸 12px에 글자가 붙어 읽기 어렵다). */
const CAL_DAY_ROWS = [0, 2, 4];
/** 첫 주의 월 글자와 다음 달 1일 글자가 이 주 수보다 가까우면 첫 글자를 뺀다(겹침 방지). */
const CAL_MONTH_MIN_COLS = 3;

/** 활동 달력. calendar는 activityCalendar() 결과, who는 aria 문장의 주어("모임" 또는 고른 사람 이름). */
export function ActivityCalendarView(props: { calendar: ActivityCalendar; who: string }) {
  const { calendar } = props;
  const weeks = calendar.weeks;
  const W = CAL_LEFT + weeks.length * STEP;
  const H = CAL_TOP + 7 * STEP;
  // 월 이름: 그달 1일이 든 주에 쓴다. 첫 주는 1일이 없어도 범위가 시작하는 달을 쓴다.
  const months: { col: number; text: string }[] = [];
  weeks.forEach((week, col) => {
    const firstIn = week.find((c) => !c.outside);
    const first = week.find((c) => !c.outside && c.date.endsWith("-01"));
    const mark = first ?? (col === 0 ? firstIn : undefined);
    if (mark) months.push({ col, text: `${Number(mark.date.slice(5, 7))}월` });
  });
  if (
    months.length >= 2 &&
    months[1]!.col - months[0]!.col < CAL_MONTH_MIN_COLS &&
    !weeks[0]!.some((c) => c.date.endsWith("-01"))
  ) {
    months.shift();
  }
  return (
    <div className="cal-scroll">
      <svg
        className="cal"
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`${props.who} 활동 달력: 경기한 날 ${calendar.activeDays}일, ${calendar.total}경기`}
      >
        {months.map((m) => (
          <text key={m.col} className="cal-axis" x={CAL_LEFT + m.col * STEP} y={CAL_MONTH_BASELINE}>
            {m.text}
          </text>
        ))}
        {CAL_DAY_ROWS.map((d) => (
          <text key={d} className="cal-axis" x={0} y={CAL_TOP + d * STEP + CELL - CAL_DAY_RAISE}>
            {WEEKDAY_LABEL[d]}
          </text>
        ))}
        {weeks.map((week, col) =>
          week.map((cell) =>
            cell.outside ? null : (
              <rect
                key={cell.date}
                className={`cal-cell cal-l${cell.level}`}
                x={CAL_LEFT + col * STEP}
                y={CAL_TOP + cell.weekday * STEP}
                width={CELL}
                height={CELL}
                rx={CELL_RADIUS}
              >
                <title>{`${cell.date} (${WEEKDAY_LABEL[cell.weekday]}) · ${cell.count}경기`}</title>
              </rect>
            ),
          ),
        )}
      </svg>
    </div>
  );
}

/** 달력 색 범례. 단계 경계는 graphs.ts CALENDAR_LEVELS와 같아야 한다(바꾸면 함께). */
export function CalendarLegend() {
  const steps = ["0", "1~2", "3~5", "6~9", "10+"];
  return (
    <p className="cal-legend" aria-label="칸 색: 그날 경기 수 0, 1~2, 3~5, 6~9, 10 이상">
      <span>적음</span>
      {steps.map((s, i) => (
        <span key={s} className="cal-legend-step" title={`${s}경기`}>
          <svg width={CELL} height={CELL} aria-hidden="true">
            <rect className={`cal-cell cal-l${i}`} width={CELL} height={CELL} rx={CELL_RADIUS} />
          </svg>
        </span>
      ))}
      <span>많음 (하루 경기 수)</span>
    </p>
  );
}
