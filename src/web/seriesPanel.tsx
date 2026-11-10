import { useMemo, useState } from "react";
import {
  compositionKey,
  SERIES_FORMAT_LABEL,
  SERIES_NAME_MAX,
  SERIES_TEAMS_DIFFER_TEXT,
  SERIES_WINS_NEEDED,
  seriesIndex,
  seriesLine,
  seriesReference,
  seriesScore,
  seriesTeamNames,
  seriesTitle,
  teamKey,
  type SeriesScore,
} from "../shared/series";
import { SERIES_FORMATS, type MatchView, type SeriesFormat, type SeriesView, type Snapshot, type Team } from "../shared/types";
import { mutate, newRequestId } from "./api";
import { formatDate, STATE_LABEL } from "./format";
import { Dialog, ErrorNote } from "./ui";
import type { AppValue } from "./useApp";

/**
 * 시리즈 묶음 화면 조각(src/shared/series.ts). 경기 상세·기록 화면·경기 카드가 함께 쓴다.
 * 모두 스냅숏에 이미 있는 값으로 그려 불러오는 동안 높이가 바뀌지 않는다.
 */

/** 경기 카드의 짧은 배지: "결승 · 2:1"(이름이 없으면 "시리즈 · 2:1"). */
export function seriesBadgeText(score: SeriesScore): string {
  return `${seriesTitle(score.series)} · ${score.wins[0]}:${score.wins[1]}`;
}

/** 경기 ID → 카드 배지 글. 카드 목록을 그리는 화면이 한 번 만들어 쓴다. */
export function useSeriesBadges(snapshot: Snapshot | null): (matchId: string) => string | null {
  return useMemo(() => {
    const index = seriesIndex(snapshot?.series);
    const cache = new Map<string, string>();
    for (const s of snapshot?.series ?? []) {
      const text = seriesBadgeText(seriesScore(s, snapshot!.matches));
      for (const id of s.matchIds) cache.set(id, text);
    }
    return (matchId: string) => (index.has(matchId) ? (cache.get(matchId) ?? null) : null);
  }, [snapshot]);
}

/**
 * 요약 화면 전광판 가운데 숫자: 이 경기가 속한 시리즈의 지금 점수를 이 경기의 팀 A·B 쪽으로 옮긴 것.
 * 시리즈 점수(seriesScore)는 기준 판의 팀 A였던 사람들 쪽이 앞이라, 이 경기에서 그 사람들이 팀 B면 뒤집는다.
 * 시리즈에 없거나 구성이 달라 점수에서 뺀 판(mismatch·dropped)이면 null(전광판은 숫자 없이 승패만 쓴다).
 */
export function seriesScoreOfMatch(
  snapshot: Snapshot,
  match: MatchView,
): { title: string; wins: Record<Team, number> } | null {
  const series = seriesIndex(snapshot.series).get(match.id);
  if (!series) return null;
  const score = seriesScore(series, snapshot.matches);
  const game = score.games.find((g) => g.match.id === match.id);
  if (!game || game.status === "mismatch" || game.status === "dropped") return null;
  const aIsFirst = teamKey(match.roster, "A") === score.teams[0].join(",");
  return {
    title: seriesTitle(series),
    wins: aIsFirst ? { A: score.wins[0], B: score.wins[1] } : { A: score.wins[1], B: score.wins[0] },
  };
}

/** 판 하나의 짧은 결과 글. */
function gameText(score: SeriesScore, index: number, names: [string, string]): string {
  const game = score.games[index]!;
  const head = `${index + 1}판 · ${game.match.matchNo}경기`;
  if (game.status === "counted") return `${head} · ${names[game.winner!]} 승`;
  if (game.status === "pending") return `${head} · ${STATE_LABEL[game.match.state]}`;
  if (game.status === "mismatch") return `${head} · 구성 다름(점수 제외)`;
  return `${head} · ${STATE_LABEL[game.match.state]}(점수 제외)`;
}

/** 시리즈 요약: 이름·형식·점수, 두 팀 이름, 각 판 링크, 경고. */
export function SeriesSummary(props: {
  series: SeriesView;
  snapshot: Snapshot;
  nameOf: (id: string) => string;
  openMatch: (id: string) => void;
  /** 지금 보고 있는 경기(상세 화면). 그 판은 링크 대신 굵게. */
  currentId?: string;
}) {
  const score = seriesScore(props.series, props.snapshot.matches);
  const names = seriesTeamNames(score.teams, props.nameOf);
  const need = SERIES_WINS_NEEDED[props.series.format];
  const dropped = score.games.filter((g) => g.status === "dropped").length;
  return (
    <div className="series-summary">
      <p className="series-line">
        <strong>{seriesLine(score)}</strong>
      </p>
      <p className="hint">
        {names[0]} {score.wins[0]} : {score.wins[1]} {names[1]}
        {score.winner !== null ? ` · ${names[score.winner]} 시리즈 승리` : ""}
      </p>
      <ol className="series-games" aria-label={`${seriesTitle(props.series)}의 판`}>
        {score.games.map((game, i) => (
          <li key={game.match.id}>
            {game.match.id === props.currentId ? (
              <strong>{gameText(score, i, names)}</strong>
            ) : (
              <button type="button" className="link" onClick={() => props.openMatch(game.match.id)}>
                {gameText(score, i, names)}
              </button>
            )}
          </li>
        ))}
      </ol>
      {score.overflow && need !== null && (
        <p className="note warn">
          {SERIES_FORMAT_LABEL[props.series.format]}인데 {need}승을 채운 뒤에도 판이 더 있어요. 형식을 바꾸거나 판을 빼
          주세요.
        </p>
      )}
      {score.mismatched > 0 && (
        <p className="note warn">팀 구성이 기준 구성(가장 많은 판의 구성)과 다른 판 {score.mismatched}개는 점수에서 뺐어요.</p>
      )}
      {dropped > 0 && <p className="hint">전적 제외·미진행 취소된 판 {dropped}개는 점수에서 뺐어요.</p>}
    </div>
  );
}

/**
 * 아직 성공하지 않은 요청의 ID(주소·내용 → 요청 ID). 실패("확인 불가" 등) 뒤 같은 버튼을 다시 누르면 같은 ID로
 * 보내, 앞 요청이 실제로 저장됐더라도 서버가 한 번만 처리한다. 성공하면 지워 다음 같은 동작은 새 ID를 쓴다.
 */
const pendingRequests = new Map<string, string>();

async function send(app: AppValue, path: string, body: Record<string, unknown>): Promise<void> {
  const url = `/api/groups/${app.snapshot!.group.id}${path}`;
  const key = `${url}\n${JSON.stringify(body)}`;
  let requestId = pendingRequests.get(key);
  if (!requestId) {
    requestId = newRequestId();
    pendingRequests.set(key, requestId);
  }
  await mutate(url, { requestId, ...body });
  pendingRequests.delete(key);
  await app.refreshAfterOwnChange();
}

/** 형식·이름 입력(새 시리즈). */
function SeriesFields(props: {
  format: SeriesFormat;
  name: string;
  onFormat: (f: SeriesFormat) => void;
  onName: (n: string) => void;
}) {
  return (
    <div className="filter-row">
      <label>
        형식
        <select aria-label="시리즈 형식" value={props.format} onChange={(e) => props.onFormat(e.target.value as SeriesFormat)}>
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
          value={props.name}
          onChange={(e) => props.onName(e.target.value)}
        />
      </label>
    </div>
  );
}

/**
 * 경기 상세의 시리즈 구역. 시리즈에 있으면 요약과(운영자) 빼기, 없으면(운영자·확정 경기) 넣기·새로 만들기.
 * 조회자에게는 시리즈에 있을 때만 보인다.
 */
export function MatchSeriesSection(props: {
  snapshot: Snapshot;
  match: MatchView;
  app: AppValue | null;
  nameOf: (id: string) => string;
  openMatch: (id: string) => void;
}) {
  const { snapshot, match, app } = props;
  const series = seriesIndex(snapshot.series).get(match.id) ?? null;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [format, setFormat] = useState<SeriesFormat>("bo3");
  const [name, setName] = useState("");
  if (!series && !(app && match.state === "confirmed")) return null;

  async function run(path: string, body: Record<string, unknown>) {
    if (!app) return;
    setBusy(true);
    setError(null);
    try {
      await send(app, path, body);
      setOpen(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const key = compositionKey(match.roster);
  const others = (snapshot.series ?? []).filter((s) => s.id !== series?.id);
  return (
    <section aria-label="시리즈">
      <h2>시리즈</h2>
      {series ? (
        <>
          <SeriesSummary
            series={series}
            snapshot={snapshot}
            nameOf={props.nameOf}
            openMatch={props.openMatch}
            currentId={match.id}
          />
          {app && (
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void run(`/series/${series.id}/remove`, { matchId: match.id })}
              >
                이 경기를 시리즈에서 빼기
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="hint">시리즈에 들어 있지 않아요. 같은 사람들끼리 한 판 더 했다면 한 시리즈로 묶을 수 있어요.</p>
          <button type="button" className="secondary" onClick={() => setOpen(true)}>
            시리즈에 넣기
          </button>
        </>
      )}
      {!open && <ErrorNote error={error} />}
      {open && app && (
        <Dialog title={`${match.matchNo}경기를 시리즈에 넣기`} onClose={() => setOpen(false)}>
          {others.length > 0 && (
            <>
              <h3>기존 시리즈에 넣기</h3>
              <ul className="list series-pick">
                {[...others].reverse().map((s) => {
                  const ref = seriesReference(s, snapshot.matches);
                  const fits = ref !== null && compositionKey(ref.roster) === key;
                  const score = seriesScore(s, snapshot.matches);
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="list-row"
                        disabled={busy || !fits}
                        onClick={() => void run(`/series/${s.id}/add`, { matchId: match.id })}
                      >
                        <span>
                          {seriesLine(score)}
                          <br />
                          <span className="hint">
                            {fits
                              ? `${s.matchIds.length}판 · ${ref ? formatDate(ref.playedAt, snapshot.group.timezone) : ""}`
                              : "팀 구성이 달라 넣을 수 없어요"}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <h3>새 시리즈 만들기</h3>
          <SeriesFields format={format} name={name} onFormat={setFormat} onName={setName} />
          <ErrorNote error={error} />
          <button
            type="button"
            className="primary wide"
            disabled={busy}
            onClick={() =>
              void run("/series", { format, name: name.trim() || null, matchIds: [match.id] })
            }
          >
            {busy ? "저장 중" : "이 경기로 새 시리즈 만들기"}
          </button>
          <p className="hint">{SERIES_TEAMS_DIFFER_TEXT}</p>
        </Dialog>
      )}
    </section>
  );
}

/**
 * 기록 화면의 "시리즈" 보기. 범위 안에 판이 하나라도 있는 시리즈를 최근 것부터.
 * 운영자는 범위 안의 확정 경기로 새 시리즈를 만들 수 있다.
 */
export function SeriesListSection(props: {
  snapshot: Snapshot;
  scoped: readonly MatchView[];
  nameOf: (id: string) => string;
  openMatch: (id: string) => void;
  app: AppValue | null;
}) {
  const { snapshot, app } = props;
  const [open, setOpen] = useState(false);
  const inScope = new Set(props.scoped.map((m) => m.id));
  const list = (snapshot.series ?? []).filter((s) => s.matchIds.some((id) => inScope.has(id))).reverse();
  if (list.length === 0 && !app) return null;
  return (
    <section aria-label="시리즈">
      <h2>시리즈 {list.length}개</h2>
      {list.length === 0 ? (
        <p className="hint">이 범위에는 시리즈가 없어요. 같은 사람들끼리 여러 판 했다면 시리즈로 묶어 보세요.</p>
      ) : (
        <ul className="list">
          {list.map((s) => (
            <li key={s.id} className="list-row static">
              <SeriesSummary series={s} snapshot={snapshot} nameOf={props.nameOf} openMatch={props.openMatch} />
            </li>
          ))}
        </ul>
      )}
      {app && (
        <button type="button" className="secondary" onClick={() => setOpen(true)}>
          새 시리즈 만들기
        </button>
      )}
      {open && app && (
        <NewSeriesDialog
          app={app}
          snapshot={snapshot}
          scoped={props.scoped}
          nameOf={props.nameOf}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

/** 확정 경기를 골라 새 시리즈를 만드는 창. 처음 고른 판과 구성이 다른 판은 고를 수 없다. */
function NewSeriesDialog(props: {
  app: AppValue;
  snapshot: Snapshot;
  scoped: readonly MatchView[];
  nameOf: (id: string) => string;
  onClose: () => void;
}) {
  const { app, snapshot } = props;
  const [picked, setPicked] = useState<string[]>([]);
  const [format, setFormat] = useState<SeriesFormat>("bo3");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const index = seriesIndex(snapshot.series);
  const candidates = [...props.scoped]
    .filter((m) => m.state === "confirmed" && !index.has(m.id))
    .sort((a, b) => b.playedAt.localeCompare(a.playedAt) || b.matchNo - a.matchNo)
    .slice(0, 40);
  const first = candidates.find((m) => m.id === picked[0]) ?? null;
  const key = first ? compositionKey(first.roster) : null;
  const tz = snapshot.group.timezone;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await send(app, "/series", { format, name: name.trim() || null, matchIds: picked });
      props.onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="새 시리즈 만들기" onClose={props.onClose}>
      <p className="hint">
        결과가 확정된 경기 중 같은 사람들끼리 한 판들을 고르세요. 진영은 판마다 달라도 되지만 두 팀의 5명 구성은 같아야 해요.
      </p>
      {candidates.length === 0 ? (
        <p className="hint">이 범위에는 시리즈에 넣을 수 있는 확정 경기가 없어요.</p>
      ) : (
        <ul className="list series-pick" aria-label="시리즈에 넣을 경기">
          {candidates.map((m) => {
            const fits = key === null || compositionKey(m.roster) === key;
            const checked = picked.includes(m.id);
            const lead = m.roster.filter((r) => r.team === "A").map((r) => props.nameOf(r.participantId));
            return (
              <li key={m.id}>
                <label className={checked ? "list-row selected" : "list-row"}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!checked && !fits}
                    onChange={(e) =>
                      setPicked(e.target.checked ? [...picked, m.id] : picked.filter((id) => id !== m.id))
                    }
                  />
                  <span>
                    {m.matchNo}경기 · {formatDate(m.playedAt, tz)}
                    <br />
                    <span className="hint">{fits ? lead.join(" · ") : "팀 구성이 달라 고를 수 없어요"}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <SeriesFields format={format} name={name} onFormat={setFormat} onName={setName} />
      <ErrorNote error={error} />
      <button type="button" className="primary wide" disabled={busy || picked.length === 0} onClick={() => void create()}>
        {busy ? "저장 중" : `${picked.length}판으로 시리즈 만들기`}
      </button>
    </Dialog>
  );
}
