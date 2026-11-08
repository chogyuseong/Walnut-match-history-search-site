import { useMemo } from "react";
import {
  ACTIVE_WINDOW,
  HOT_STREAK_MIN,
  lineRanking,
  newestFirst,
  personForms,
  rankAndSearch,
  RECENT_FORM_GAMES,
  recentResults,
  streakText,
  trends,
} from "../../shared/insights";
import { isCounted } from "../../shared/stats";
import type { Snapshot } from "../../shared/types";
import { nameMap, rateTier, standingsOf } from "../format";
import { MatchCard } from "../matchCard";
import { useSeriesBadges } from "../seriesPanel";
import { FormDots, StandingNote } from "../ui";

/** 결과를 저장한 경기가 없을 때. 무엇이 쌓이는지만 짧게 알려준다. */
export function DashboardEmpty() {
  return (
    <section className="card dash-empty" aria-label="기록 요약 안내">
      <h2>기록이 쌓이면 여기에</h2>
      <ul className="dash-empty-list">
        <li>최근 경기 5개 — 양 팀 명단과 이긴 팀</li>
        <li>랭킹 상위 5명 — 배치(누적 10경기)를 마친 사람 먼저</li>
        <li>요즘 흐름 — 3연승 이상 이어가는 사람, 최근 10경기 승률</li>
      </ul>
      <p className="hint">경기 결과를 저장하면 바로 채워집니다.</p>
    </section>
  );
}

/** 홈에 보여주는 최근 경기·랭킹 수. */
const RECENT_MATCHES = 5;
const TOP_PEOPLE = 5;

/**
 * 홈 아래쪽 요약: 최근 경기 5개, 랭킹 상위 5명(전체 누적), 요즘 흐름(연승 중·최근 10경기 승률).
 * 운영자 홈과 조회 링크의 요약 화면이 같이 쓴다. 확정 경기가 없으면 안내 한 줄만 낸다.
 */
export function Dashboard(props: {
  snapshot: Snapshot;
  openMatch: (id: string) => void;
  openPerson: (id: string) => void;
  openRanking: () => void;
  /** 위에서 이미 보여준 경기(오늘의 결과)는 최근 경기에서 뺀다. */
  skipIds?: ReadonlySet<string>;
}) {
  const { snapshot, skipIds } = props;
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const seriesBadge = useSeriesBadges(snapshot);
  const counted = useMemo(() => snapshot.matches.filter(isCounted), [snapshot]);
  const recent = useMemo(
    () =>
      newestFirst(snapshot.matches.filter((m) => m.state !== "canceled" && !skipIds?.has(m.id))).slice(
        0,
        RECENT_MATCHES,
      ),
    [snapshot, skipIds],
  );
  const placement = useMemo(() => standingsOf(snapshot), [snapshot]);
  const top = useMemo(
    () =>
      rankAndSearch(lineRanking(snapshot.matches, null), placement, nameOf, "rate", "").ranked.slice(
        0,
        TOP_PEOPLE,
      ),
    [snapshot, placement, nameOf],
  );
  const forms = useMemo(() => personForms(snapshot.matches), [snapshot]);
  const flow = useMemo(() => trends(snapshot.matches, nameOf), [snapshot, nameOf]);

  if (counted.length === 0) return <DashboardEmpty />;

  return (
    <div className="dashboard">
      {recent.length > 0 && (
        <section aria-label="최근 경기">
          <div className="section-head">
            <h2>최근 경기</h2>
            <button type="button" className="link" onClick={props.openRanking}>
              기록 전체 보기
            </button>
          </div>
          <ul className="list match-cards">
            {recent.map((m) => (
              <MatchCard
                key={m.id}
                match={m}
                nameOf={nameOf}
                timeZone={snapshot.group.timezone}
                showDate
                onOpen={() => props.openMatch(m.id)}
                seriesBadge={seriesBadge(m.id)}
                onPerson={props.openPerson}
              />
            ))}
          </ul>
        </section>
      )}

      <div className="dash-grid">
        <section aria-label="랭킹 상위">
          <div className="section-head">
            <h2>랭킹 상위 {top.length}명 (전체)</h2>
            <button type="button" className="link" onClick={props.openRanking}>
              랭킹 전체
            </button>
          </div>
          <ul className="list">
            {top.map((r) => (
              <li key={r.participantId}>
                <button
                  type="button"
                  className="list-row rank-row"
                  onClick={() => props.openPerson(r.participantId)}
                >
                  <span className="rank-main">
                    <span className="rank-name">
                      <span className={r.rank <= 3 ? "rank top" : "rank"}>{r.rank}</span>{" "}
                      <span className="rank-person">{r.name}</span>
                    </span>
                    <span className="form-line">
                      <FormDots results={recentResults(forms.get(r.participantId))} />
                    </span>
                  </span>
                  <span className="stat">
                    <span className={rateTier(r.wins, r.games)}>
                      {Math.round((r.wins / r.games) * 100)}%
                    </span>{" "}
                    · {r.wins}승 {r.games - r.wins}패 ({r.games}경기)
                    <br />
                    <span className="hint">
                      <StandingNote standing={placement.get(r.participantId)} />
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="요즘 흐름">
          <h2>요즘 흐름</h2>
          <h3 className="sub-head">{HOT_STREAK_MIN}연승 이상 이어가는 중</h3>
          {flow.hotStreaks.length === 0 ? (
            <p className="hint">지금 {HOT_STREAK_MIN}연승 이상인 사람이 없어요.</p>
          ) : (
            <ul className="list">
              {flow.hotStreaks.map((row) => (
                <li key={row.participantId}>
                  <button
                    type="button"
                    className="list-row"
                    onClick={() => props.openPerson(row.participantId)}
                  >
                    <span className="name">{nameOf(row.participantId)}</span>
                    <span className="stat">
                      <strong className="streak win">{streakText(row.streak)}</strong>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h3 className="sub-head">최근 {RECENT_FORM_GAMES}경기 승률</h3>
          {flow.recentBest.length === 0 ? (
            <p className="hint">최근 {RECENT_FORM_GAMES}경기를 채운 사람이 아직 없어요.</p>
          ) : (
            <ul className="list">
              {flow.recentBest.map((row) => (
                <li key={row.participantId}>
                  <button
                    type="button"
                    className="list-row"
                    onClick={() => props.openPerson(row.participantId)}
                  >
                    <span className="name">{nameOf(row.participantId)}</span>
                    <span className="stat">
                      <span className={rateTier(row.recent.wins, row.recent.games)}>
                        {Math.round((row.recent.wins / row.recent.games) * 100)}%
                      </span>{" "}
                      · {row.recent.wins}승 {row.recent.games - row.recent.wins}패
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">
            모임의 최근 {ACTIVE_WINDOW}경기에 나온 사람만 봅니다. 최근 승률은 {RECENT_FORM_GAMES}경기를
            채운 사람만 넣습니다. 결과 미입력·제외 경기는 세지 않습니다.
          </p>
        </section>
      </div>
    </div>
  );
}
