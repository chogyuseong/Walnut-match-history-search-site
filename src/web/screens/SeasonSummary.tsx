import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  awardTitle,
  seasonSummary,
  seasonSummaryText,
  type Award,
  type AwardKey,
} from "../../shared/seasonAwards";
import { matchYears, ratePercent, type Scope } from "../../shared/stats";
import type { Snapshot } from "../../shared/types";
import { formatDate, formatRange, nameMap, POSITION_LABEL } from "../format";
import { drawSeasonImage, ShareImageDialog } from "../shareImage";
import { BackLink, Help, RoleIcon, ScreenHead } from "../screenKit";
import { CopyButton } from "../ui";

// 주소 읽고 쓰기는 ../seasonRoute.ts에 있다(첫 화면 묶음이 이 화면 코드 없이 쓰도록). 기존 import를 위해 다시 내보낸다.
import { seasonRoutePart, seasonScopeFromRoute } from "../seasonRoute";

export { seasonRoutePart, seasonScopeFromRoute };

/**
 * 가장 경기가 많았던 날이 동률로 이보다 많으면(예: 하루 1경기씩) 그 줄을 숨긴다
 * (2026-11-08 화면 점검: 날짜를 늘어놓아도 뜻이 없다).
 */
const BUSIEST_MAX = 3;

/**
 * 주소에 범위가 없을 때(#/season, #/demo/season) 보여 줄 기본 범위: 가장 최근 시즌(시작일 기준),
 * 시즌이 없으면 경기가 있는 가장 최근 연도. 둘 다 없으면 null.
 */
export function defaultSeasonScope(snapshot: Snapshot): Scope | null {
  const latest = [...snapshot.seasons].sort((a, b) => b.startsOn.localeCompare(a.startsOn))[0];
  if (latest) return { kind: "season", seasonId: latest.id };
  const years = matchYears(snapshot);
  return years.length > 0 ? { kind: "year", year: Math.max(...years) } : null;
}

/** 맨 위 큼직한 카드로 보여 줄 주요 상(seasonAwards.ts의 awards 배열 앞쪽). */
const MAIN_KEYS: readonly AwardKey[] = ["bestRate", "mostWins", "mostGames"];

/**
 * 상 종류별 작은 기호(꾸밈, aria-hidden). 직접 그린 선 도형이며 이모지는 쓰지 않는다.
 * 라인별 최고 승률은 라인 아이콘(RoleIcon)을 쓴다.
 */
const AWARD_MARKS: Record<Exclude<AwardKey, "lineBest">, ReactNode> = {
  // 왕관
  bestRate: <path d="M4 8l4 3.5L12 5l4 6.5L20 8l-2 10H6L4 8z" />,
  // 트로피
  mostWins: (
    <>
      <path d="M8 4h8v5a4 4 0 0 1-8 0V4z" />
      <path d="M8 6H5.5a2.5 2.5 0 0 0 2.6 4M16 6h2.5a2.5 2.5 0 0 1-2.6 4M12 13v4M8.5 20h7M10 17h4" />
    </>
  ),
  // 달력 + 체크
  mostGames: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
      <path d="M4 10h16M9 3.5v4M15 3.5v4M9.5 15l2 2 3.5-3.5" />
    </>
  ),
  // 번개
  longestStreak: <path d="M13 3L5.5 13.5h5.5l-1 7.5 8-11h-5.5L13 3z" />,
  // 두 사람
  bestDuo: (
    <>
      <circle cx="9" cy="8" r="3" />
      <circle cx="16.5" cy="9" r="2.5" />
      <path d="M3.5 19.5c0-3.3 2.5-5.5 5.5-5.5s5.5 2.2 5.5 5.5M15.5 14.2c2.9 0 5 1.9 5 5.3" />
    </>
  ),
  // 엇갈린 칼
  nemesis: <path d="M4.5 4.5l11 11M19.5 4.5l-11 11M6 15l3 3M18 15l-3 3M4.5 19.5l2.5-2.5M19.5 19.5L17 17" />,
  // 오르는 선
  mostImproved: <path d="M4 17l5.5-5.5 4 4L20 9M15 9h5v5" />,
  // 하트
  mostSupport: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />,
  // 느낌표가 든 원(뜻밖의 결과)
  upsetMaker: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5v5.5M12 16v.5" />
    </>
  ),
};

/**
 * 시즌 종료 요약과 시상(src/shared/seasonAwards.ts). 운영자·조회 링크가 같은 화면을 본다.
 * 모두 스냅숏에서 계산하므로 불러온 뒤 높이가 바뀌지 않는다.
 * 티어·기피 라인은 쓰지 않는다(조회 링크에서도 보는 화면).
 */
export function SeasonSummaryScreen(props: {
  snapshot: Snapshot;
  scope: Scope | null;
  back: () => void;
  choose: (scope: Scope) => void;
}) {
  const { snapshot } = props;
  // 범위 없이 열면 가장 최근 시즌(없으면 최근 연도)을 보여 준다. 잘못된 시즌 ID는 그대로 "찾을 수 없어요".
  const scope = props.scope ?? defaultSeasonScope(snapshot);
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const [imageOpen, setImageOpen] = useState(false);
  const valid =
    scope !== null &&
    (scope.kind === "year" || (scope.kind === "season" && snapshot.seasons.some((s) => s.id === scope.seasonId)));
  const summary = useMemo(
    () => (valid && scope ? seasonSummary(snapshot, scope, nameOf) : null),
    [snapshot, scope, valid, nameOf],
  );
  const years = matchYears(snapshot);

  const picker = (
    <label className="rank-line">
      범위
      <select
        aria-label="요약 범위"
        value={scope ? seasonRoutePart(scope) : ""}
        onChange={(e) => {
          const next = seasonScopeFromRoute(e.target.value.split("/"));
          if (next) props.choose(next);
        }}
      >
        {!valid && <option value="">고르기</option>}
        {[...snapshot.seasons].reverse().map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
        {years.map((y) => (
          <option key={y} value={`year/${y}`}>
            {y}년
          </option>
        ))}
      </select>
    </label>
  );

  if (!summary) {
    return (
      <div className="screen">
        <BackLink label="← 기록" fallback={props.back} />
        <h1>시즌 요약</h1>
        <p>시즌을 찾을 수 없어요. 아래에서 시즌이나 연도를 골라 주세요.</p>
        {picker}
      </div>
    );
  }

  const tz = snapshot.group.timezone;
  const blue = summary.sides.known > 0 ? ratePercent(summary.sides.blueWins, summary.sides.known) : null;
  const awardKey = (a: Award) => `${a.key}-${a.position ?? ""}`;
  // 수상자가 있는 상만 카드로 그리고, 해당 없는 상은 맨 아래 한 줄로 모은다(2026-11-08 화면 점검).
  const given = summary.awards.filter((a) => a.winners.length > 0);
  const notGiven = summary.awards.filter((a) => a.winners.length === 0);
  const mainAwards = given.filter((a) => MAIN_KEYS.includes(a.key));
  const lineAwards = given.filter((a) => a.position !== undefined);
  const otherAwards = given.filter((a) => !MAIN_KEYS.includes(a.key) && a.position === undefined);
  const showBusiest = summary.busiestDays.length > 0 && summary.busiestDays.length <= BUSIEST_MAX;
  return (
    <div className="screen page-wide season-summary">
      <ScreenHead
        back={<BackLink label="← 기록" fallback={props.back} />}
        title={`${summary.label} 요약`}
        badge={<span className={summary.ongoing ? "badge" : "badge ok"}>{summary.ongoing ? "진행 중" : "종료"}</span>}
        desc={
          <>
            <span className="season-dates">{formatRange(summary.startsOn, summary.endsOn, tz)}</span>
            {summary.ongoing ? " · 진행 중이라 숫자가 바뀔 수 있어요." : ""}
          </>
        }
      />
      <div className="season-tools">
        {picker}
        <div className="button-row">
          <button type="button" className="secondary" disabled={summary.games === 0} onClick={() => setImageOpen(true)}>
            요약 이미지
          </button>
          <CopyButton label="텍스트 복사" text={() => seasonSummaryText(summary, snapshot.group.name, nameOf)} />
        </div>
      </div>

      <section className="graph-summary" aria-label="요약">
        <h2>요약</h2>
        {summary.games === 0 ? (
          <p className="hint">이 범위에는 확정된 경기가 없어요.</p>
        ) : (
          <dl className="ps-tiles season-tiles">
            <div>
              <dt className="tile-label">경기</dt>
              <dd className="season-stat">
                {summary.games}
                <span className="season-unit">경기</span>
              </dd>
            </div>
            <div>
              <dt className="tile-label">참가자</dt>
              <dd className="season-stat">
                {summary.participants}
                <span className="season-unit">명</span>
              </dd>
            </div>
            <div>
              <dt className="tile-label">블루 : 레드 승률</dt>
              {blue !== null ? (
                <dd className="season-stat season-sides">
                  <span className="side-values">
                    <span className="blue">{blue}%</span>
                    <span className="side-colon"> : </span>
                    <span className="red">{100 - blue}%</span>
                  </span>
                  <span className="side-bar" aria-hidden="true">
                    <span className="side-blue" style={{ flexGrow: blue }} />
                    <span className="side-red" style={{ flexGrow: 100 - blue }} />
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
        )}
        {/* 내전한 날 수는 요약 칸(최대 셋)에서 이 줄로 내렸다. */}
        {summary.games > 0 && (
          <p className="hint">
            내전한 날 {summary.days}일
            {showBusiest &&
              ` · 가장 경기가 많았던 날: ${summary.busiestDays.map((d) => formatDate(d.date, tz)).join(", ")} (${summary.busiestDays[0]!.games}경기)`}
          </p>
        )}
        {summary.sides.unknown > 0 && (
          <p className="hint">진영 승률은 진영을 아는 {summary.sides.known}경기로만 셌어요.</p>
        )}
      </section>

      <section aria-label="시상" className="season-awards">
        <h2>시상</h2>
        {mainAwards.length > 0 && (
          <ul className="award-list award-list-main">
            {mainAwards.map((award) => (
              <AwardItem key={awardKey(award)} award={award} nameOf={nameOf} kind="main" />
            ))}
          </ul>
        )}
        {lineAwards.length > 0 && (
          <>
            <p className="row-label">라인별 최고 승률</p>
            {/* 다섯 라인의 기준은 같으므로 카드마다 반복하지 않고 소제목 아래 한 줄로 둔다(2026-11-10). */}
            <p className="hint award-line-rule">{lineAwards[0]!.rule}</p>
            <ul className="award-list award-list-lines">
              {lineAwards.map((award) => (
                <AwardItem key={awardKey(award)} award={award} nameOf={nameOf} kind="line" />
              ))}
            </ul>
          </>
        )}
        {otherAwards.length > 0 && (
          <>
            <p className="row-label">특별상</p>
            <ul className="award-list award-list-more">
              {otherAwards.map((award) => (
                <AwardItem key={awardKey(award)} award={award} nameOf={nameOf} kind="more" />
              ))}
            </ul>
          </>
        )}
        {notGiven.length > 0 && <NotGiven awards={notGiven} />}
        <p className="hint">
          결과가 확정되고 전적 제외가 아닌 경기만 셉니다. 동률이면 공동 수상이에요.
          {summary.previous ? "" : " 직전 시즌이 없어 '가장 많이 성장'은 넣지 않았어요."}
        </p>
      </section>

      {imageOpen && (
        <ShareImageDialog
          title={`${summary.label} 요약 이미지`}
          fileName={`${summary.label.replace(/[\\/:*?"<>|\s]+/g, "-")}-요약.png`}
          make={() => drawSeasonImage(snapshot, summary)}
          onClose={() => setImageOpen(false)}
        />
      )}
    </div>
  );
}

/** 공동 수상이 이보다 많으면 앞의 이만큼만 보이고 나머지는 "외 n명"으로 접는다(개근상 열 명이 카드를 늘이던 것). */
const WINNERS_SHOWN = 3;

/**
 * 수상자 한 줄을 이름(크게)과 근거 숫자(보조 톤)로 나눠 그린다.
 * 글자 내용은 awardWinnersText와 똑같이 맞춘다(텍스트 복사·공유 이미지와 같은 글, e2e가 이 글을 본다).
 * 공동 수상의 " / "는 줄을 나눠 보여 주므로 화면에서는 숨기고 화면 읽기 프로그램에는 남긴다.
 * 접힌 수상자도 DOM에는 hidden으로 남겨 둔다: 글자 확인(textContent)과 텍스트 복사가 펼침 여부에 흔들리지 않게.
 * "외 1명"은 이름 하나 보이는 것과 자리가 같아 쓰지 않는다(WINNERS_SHOWN + 1명까지는 다 보인다).
 */
function Winners(props: { award: Award; nameOf: (id: string) => string }) {
  const { award, nameOf } = props;
  const [expanded, setExpanded] = useState(false);
  const joiner = award.key === "nemesis" ? " → " : " · ";
  const folds = award.winners.length > WINNERS_SHOWN + 1;
  const hiddenCount = folds && !expanded ? award.winners.length - WINNERS_SHOWN : 0;
  return (
    <p className="winner">
      {award.winners.map((w, i) => (
        <Fragment key={w.participantIds.join("|")}>
          {i > 0 && <span className="sr-only"> / </span>}
          <span className="award-entry" hidden={hiddenCount > 0 && i >= WINNERS_SHOWN}>
            <span className="award-who">{w.participantIds.map(nameOf).join(joiner)}</span>{" "}
            <span className="award-why">{w.value}</span>
          </span>
        </Fragment>
      ))}
      {award.winners.length > 1 && <span className="award-tie"> (공동)</span>}
      {folds && (
        <button type="button" className="link award-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? "접기" : `외 ${hiddenCount}명 보기`}
        </button>
      )}
    </p>
  );
}

const LINE_SHORT: Record<string, string> = { top: "탑", jungle: "정글", mid: "미드", adc: "원딜", support: "서폿" };

/**
 * 해당 없는 상을 한 줄로 모은다: "기준 미달: 최고 승률, 탑·정글 최고 승률". 상마다의 까닭은 접힌 도움말 안 목록에 둔다.
 * 목록 항목은 "시상" 구역 안 listitem이고 상 이름을 제목(h3)으로 가져 보조 기기·테스트가 상 이름으로 찾을 수 있다.
 */
function NotGiven(props: { awards: Award[] }) {
  const lines = props.awards.filter((a) => a.position !== undefined);
  const others = props.awards.filter((a) => a.position === undefined);
  const names = [
    ...others.map((a) => awardTitle(a)),
    ...(lines.length > 0 ? [`${lines.map((a) => LINE_SHORT[a.position!]).join("·")} 최고 승률`] : []),
  ];
  return (
    <div className="award-none">
      <p className="hint">기준 미달: {names.join(", ")}</p>
      <Help label="기준 미달 까닭">
        <ul className="award-none-list" aria-label="기준 미달 상">
          {props.awards.map((a) => (
            <li key={`${a.key}-${a.position ?? ""}`}>
              <h3>{awardTitle(a)}</h3>
              <p>
                해당 없음 · {a.none ?? ""} <span className="award-rule">기준: {a.rule}</span>
              </p>
            </li>
          ))}
        </ul>
      </Help>
    </div>
  );
}

function AwardItem(props: { award: Award; nameOf: (id: string) => string; kind: "main" | "line" | "more" }) {
  const { award } = props;
  const none = award.winners.length === 0;
  const mark =
    award.position !== undefined ? (
      <RoleIcon position={award.position} />
    ) : award.key !== "lineBest" ? (
      <svg
        className="award-mark-svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {AWARD_MARKS[award.key]}
      </svg>
    ) : null;
  return (
    <li
      className={`award award-${props.kind} award-k-${award.key}${award.position ? ` award-p-${award.position}` : ""}${none ? " is-none" : ""}`}
    >
      <div className="award-head">
        <span className="award-mark" aria-hidden="true">
          {mark}
        </span>
        {award.position !== undefined ? (
          // 라인 카드: 라인 이름을 앞에 한 줄로, "최고 승률"은 흐린 꼬리표로(좁은 칸에서 "승\n률"로 꺾이지 않게).
          // 제목 글은 awardTitle과 같은 "정글 최고 승률"이다.
          <h3>
            <span className="award-line-name">{POSITION_LABEL[award.position]}</span>{" "}
            <span className="award-line-tail">최고 승률</span>
          </h3>
        ) : (
          <h3>{awardTitle(award)}</h3>
        )}
      </div>
      {none ? (
        <p className="winner">해당 없음 · {award.none ?? ""}</p>
      ) : (
        <Winners award={award} nameOf={props.nameOf} />
      )}
      {props.kind !== "line" && <p className="award-rule">{award.rule}</p>}
    </li>
  );
}
