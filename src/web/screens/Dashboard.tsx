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
import { isCounted, placementGamesOf } from "../../shared/stats";
import type { Snapshot } from "../../shared/types";
import { nameMap, rankClass, rateText, rateTier, standingsOf } from "../format";
import { MatchCard, MatchScoreboard, useExpectations } from "../matchCard";
import { seriesScoreOfMatch, useSeriesBadges } from "../seriesPanel";
import { FormDots, StandingNote } from "../ui";

/** 결과를 저장한 경기가 없을 때. 무엇이 쌓이는지만 짧게 알려준다. */
export function DashboardEmpty() {
  return (
    <section className="card dash-empty" aria-label="기록 요약 안내">
      <h2>기록이 쌓이면 여기에</h2>
      <ul className="dash-empty-list">
        <li>최근 경기 5개 — 양 팀 명단과 이긴 팀</li>
        <li>랭킹 상위 5명 — 배치를 마친 사람 먼저</li>
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
 * 요약 탭(headline)에서는 가장 최근 확정 경기를 전광판(MatchScoreboard)으로 크게 올리고 나머지를 "이전 경기" 카드로 둔다.
 * 운영자 홈은 위에 오늘의 결과가 따로 있어 전광판을 두지 않는다.
 */
export function Dashboard(props: {
  snapshot: Snapshot;
  openMatch: (id: string) => void;
  openPerson: (id: string) => void;
  openRanking: () => void;
  /** 위에서 이미 보여준 경기(오늘의 결과)는 최근 경기에서 뺀다. */
  skipIds?: ReadonlySet<string>;
  /** 가장 최근 확정 경기를 전광판으로 올린다(조회·예시 요약 탭). */
  headline?: boolean;
}) {
  const { snapshot, skipIds } = props;
  const nameOf = useMemo(() => nameMap(snapshot), [snapshot]);
  const seriesBadge = useSeriesBadges(snapshot);
  const expectation = useExpectations(snapshot);
  const counted = useMemo(() => snapshot.matches.filter(isCounted), [snapshot]);
  // 전광판은 확정 경기만 올린다(결과 미입력·제외 경기는 크게 걸 승패가 없다). 그보다 새 미확정 경기는 아래 카드에 남는다.
  // 전광판까지 합쳐 최근 경기 RECENT_MATCHES개다.
  const { headline, olderOnly, recent } = useMemo(() => {
    const newest = newestFirst(snapshot.matches.filter((m) => m.state !== "canceled" && !skipIds?.has(m.id)));
    const top = props.headline ? (newest.find(isCounted) ?? null) : null;
    return {
      headline: top,
      // 전광판 경기보다 새 미확정 경기가 아래 목록에 있으면 그 목록을 "이전 경기"라고 부를 수 없다.
      olderOnly: top !== null && newest[0] === top,
      recent: newest.filter((m) => m !== top).slice(0, top ? RECENT_MATCHES - 1 : RECENT_MATCHES),
    };
  }, [snapshot, skipIds, props.headline]);
  const headlineSeries = useMemo(() => (headline ? seriesScoreOfMatch(snapshot, headline) : null), [snapshot, headline]);
  const placement = useMemo(() => standingsOf(snapshot), [snapshot]);
  const placementGames = placementGamesOf(snapshot.group.settings);
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
      {headline && (
        <MatchScoreboard
          match={headline}
          nameOf={nameOf}
          timeZone={snapshot.group.timezone}
          onOpen={() => props.openMatch(headline.id)}
          onPerson={props.openPerson}
          series={headlineSeries}
          upset={expectation.get(headline.id)?.upset}
        />
      )}
      {recent.length > 0 && (
        <section aria-label={olderOnly ? "이전 경기" : "최근 경기"}>
          <div className="section-head">
            <h2>{olderOnly ? "이전 경기" : "최근 경기"}</h2>
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
                upset={expectation.get(m.id)?.upset}
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
          <ul className="list list-card">
            {top.map((r) => (
              <li key={r.participantId}>
                <button
                  type="button"
                  className="list-row rank-row"
                  onClick={() => props.openPerson(r.participantId)}
                >
                  <span className="rank-main">
                    <span className="rank-name">
                      <span className={rankClass(r.rank)}>{r.rank}</span>{" "}
                      <span className="rank-person">{r.name}</span>
                    </span>
                    <span className="form-line">
                      <FormDots results={recentResults(forms.get(r.participantId))} />
                    </span>
                  </span>
                  <span className="stat">
                    <span className={rateTier(r.wins, r.games)}>
                      {rateText(r.wins, r.games)}
                    </span>{" "}
                    · {r.wins}승 {r.games - r.wins}패 ({r.games}경기)
                    <br />
                    <span className="hint">
                      <StandingNote standing={placement.get(r.participantId)} placementGames={placementGames} compact />
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
            <ul className="list list-card">
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
            <ul className="list list-card">
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
                        {rateText(row.recent.wins, row.recent.games)}
                      </span>{" "}
                      · {row.recent.wins}승 {row.recent.games - row.recent.wins}패 ({row.recent.games}경기)
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
