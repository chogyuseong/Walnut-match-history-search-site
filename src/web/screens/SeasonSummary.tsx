import { useMemo, useState } from "react";
import { awardTitle, awardWinnersText, seasonSummary, seasonSummaryText, type Award } from "../../shared/seasonAwards";
import { matchYears, type Scope } from "../../shared/stats";
import type { Snapshot } from "../../shared/types";
import { nameMap } from "../format";
import { drawSeasonImage, ShareImageDialog } from "../shareImage";
import { BackLink, CopyButton } from "../ui";

// 주소 읽고 쓰기는 ../seasonRoute.ts에 있다(첫 화면 묶음이 이 화면 코드 없이 쓰도록). 기존 import를 위해 다시 내보낸다.
import { seasonRoutePart, seasonScopeFromRoute } from "../seasonRoute";

export { seasonRoutePart, seasonScopeFromRoute };

/** 가장 경기가 많았던 날이 동률로 많을 때(예: 하루 1경기씩) 날짜를 다 늘어놓지 않고 앞 5개만 보여 준다. */
const BUSIEST_SHOWN = 5;

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
  const { snapshot, scope } = props;
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

  const blue = summary.sides.known > 0 ? Math.round((summary.sides.blueWins / summary.sides.known) * 100) : null;
  return (
    <div className="screen">
      <header className="screen-head">
        <BackLink label="← 기록" fallback={props.back} />
        <h1>{summary.label} 요약</h1>
        <span className={summary.ongoing ? "badge" : "badge ok"}>{summary.ongoing ? "진행 중" : "종료"}</span>
      </header>
      <p className="hint">
        {summary.startsOn} ~ {summary.endsOn}
        {summary.ongoing ? " · 진행 중이라 숫자가 바뀔 수 있어요." : ""}
      </p>
      {picker}

      <section aria-label="요약">
        <h2>요약</h2>
        {summary.games === 0 ? (
          <p className="hint">이 범위에는 확정된 경기가 없어요.</p>
        ) : (
          <p className="kpi">
            <span>
              경기<strong>{summary.games}경기</strong>
            </span>
            <span>
              참가자<strong>{summary.participants}명</strong>
            </span>
            <span>
              내전한 날<strong>{summary.days}일</strong>
            </span>
            {blue !== null && (
              <span>
                블루 : 레드 승률<strong className="blue">{blue}%</strong> :{" "}
                <strong className="red">{100 - blue}%</strong>
              </span>
            )}
          </p>
        )}
        {summary.busiestDays.length > 0 && (
          <p className="hint">
            가장 경기가 많았던 날: {summary.busiestDays.slice(0, BUSIEST_SHOWN).map((d) => d.date).join(", ")}
            {summary.busiestDays.length > BUSIEST_SHOWN ? ` 외 ${summary.busiestDays.length - BUSIEST_SHOWN}일` : ""} (
            {summary.busiestDays[0]!.games}경기)
          </p>
        )}
        {summary.sides.unknown > 0 && (
          <p className="hint">진영 승률은 진영을 아는 {summary.sides.known}경기로만 셌어요.</p>
        )}
      </section>

      <section aria-label="시상">
        <h2>시상</h2>
        <ul className="award-list">
          {summary.awards.map((award) => (
            <AwardItem key={`${award.key}-${award.position ?? ""}`} award={award} nameOf={nameOf} />
          ))}
        </ul>
        <p className="hint">
          결과가 확정되고 전적 제외가 아닌 경기만 셉니다. 동률이면 공동 수상이고, 기준에 못 미치면 "해당 없음"이에요.
          {summary.previous ? "" : " 직전 시즌이 없어 '가장 많이 성장'은 넣지 않았어요."}
        </p>
      </section>

      <section aria-label="공유">
        <h2>공유</h2>
        <div className="button-row">
          <button type="button" className="secondary" disabled={summary.games === 0} onClick={() => setImageOpen(true)}>
            요약 이미지
          </button>
          <CopyButton label="텍스트 복사" text={() => seasonSummaryText(summary, snapshot.group.name, nameOf)} />
        </div>
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

function AwardItem(props: { award: Award; nameOf: (id: string) => string }) {
  const { award } = props;
  const none = award.winners.length === 0;
  return (
    <li className={none ? "award is-none" : "award"}>
      <h3>{awardTitle(award)}</h3>
      <p className="winner">{none ? `해당 없음 · ${award.none ?? ""}` : awardWinnersText(award, props.nameOf)}</p>
      <p className="hint">{award.rule}</p>
    </li>
  );
}
