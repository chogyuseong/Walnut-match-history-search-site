import type { Draft } from "../../../shared/draft";
import { draftRoster } from "../../../shared/prepTools";
import {
  sameComposition,
  SERIES_FORMAT_LABEL,
  SERIES_NAME_MAX,
  seriesIndex,
  seriesLine,
  seriesScore,
} from "../../../shared/series";
import { SERIES_FORMATS, type SeriesFormat, type Snapshot } from "../../../shared/types";

/**
 * 시리즈로 이어가기: "다음 경기 준비"로 만든 초안이고 그 경기가 아직 기록에 살아 있을 때만 그린다.
 * 직전 경기와 두 팀 구성이 같아야 켤 수 있다.
 */
export function SeriesSection(props: { draft: Draft; snapshot: Snapshot | null; update: (next: Draft) => void }) {
  const { draft, snapshot, update } = props;
  const seriesFrom = draft.sourceMatchId
    ? (snapshot?.matches.find((m) => m.id === draft.sourceMatchId) ?? null)
    : null;
  const seriesFromUsable = seriesFrom !== null && seriesFrom.state !== "canceled" && seriesFrom.state !== "excluded";
  if (!seriesFromUsable || !seriesFrom) return null;
  const seriesSameTeams = sameComposition(seriesFrom.roster, draftRoster(draft));
  const seriesNow = seriesIndex(snapshot?.series).get(seriesFrom.id) ?? null;
  return (
    <section className="prep-tools" aria-label="시리즈">
      <h2>시리즈</h2>
      <label className="toggle">
        <input
          type="checkbox"
          checked={!!draft.series}
          disabled={!draft.series && !seriesSameTeams}
          onChange={(e) => update({ ...draft, series: e.target.checked ? { format: "bo3", name: "" } : null })}
        />{" "}
        시리즈로 이어가기
      </label>
      {!seriesSameTeams ? (
        <p className={draft.series ? "note warn" : "hint"} role={draft.series ? "alert" : undefined}>
          팀 구성이 {seriesFrom.matchNo}경기와 달라 시리즈로 이어갈 수 없어요(진영은 달라도 되지만 같은 사람들끼리여야
          해요).{draft.series ? " 이대로 시작하면 시리즈에 넣지 않아요." : ""}
        </p>
      ) : seriesNow ? (
        <p className="hint">
          {draft.series ? "다음 판으로 넣어요: " : "지금 시리즈: "}
          {seriesLine(seriesScore(seriesNow, snapshot?.matches ?? []))}
        </p>
      ) : draft.series ? (
        <div className="filter-row">
          <label>
            형식
            <select
              aria-label="시리즈 형식"
              value={draft.series.format}
              onChange={(e) => update({ ...draft, series: { ...draft.series!, format: e.target.value as SeriesFormat } })}
            >
              {SERIES_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {SERIES_FORMAT_LABEL[f]}
                </option>
              ))}
            </select>
          </label>
          <label>
            이름(선택)
            <input
              type="text"
              aria-label="시리즈 이름"
              placeholder="예: 결승"
              maxLength={SERIES_NAME_MAX}
              value={draft.series.name}
              onChange={(e) => update({ ...draft, series: { ...draft.series!, name: e.target.value } })}
            />
          </label>
        </div>
      ) : (
        <p className="hint">{seriesFrom.matchNo}경기와 같은 팀이면 한 시리즈(예: 3판 2선승)로 묶어 점수를 보여 줘요.</p>
      )}
      {draft.series && seriesSameTeams && !seriesNow && (
        <p className="hint">{seriesFrom.matchNo}경기와 이번 경기를 새 시리즈로 묶어요.</p>
      )}
    </section>
  );
}
