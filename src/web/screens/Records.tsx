import { useState } from "react";
import {
  matchesInScope,
  personRecords,
  placements,
  PLACEMENT_GAMES,
  searchByName,
  sortRanking,
  type Scope,
} from "../../shared/stats";
import {
  sideOfTeam,
  type MatchView,
  type Position,
  type Side,
  type Snapshot,
  type Team,
} from "../../shared/types";
import { ApiFailure, mutate, newRequestId } from "../api";
import {
  formatDate,
  formatTime,
  nameMap,
  POSITION_LABEL,
  resultLine,
  SIDE_LABEL,
  STATE_LABEL,
  teamRoster,
} from "../format";
import { Dialog, ErrorNote, MatchTeams } from "../ui";
import type { AppValue } from "../useApp";
import { ResultSheet } from "./ResultSheet";

const REVISION_LABEL: Record<string, string> = {
  start: "경기 시작",
  end: "경기 종료(결과 미입력)",
  result: "결과 확정",
  correction: "정정",
  exclude: "전적 제외",
  restore: "복구",
  cancel: "미진행 취소",
  backfill: "지난 경기 입력",
};

function changeText(key: string, nameOf: (id: string) => string): string {
  if (key === "winnerTeam") return "승리 팀";
  if (key === "teamASide") return "진영";
  if (key === "playedAt") return "경기 시각";
  if (key === "participant") return "참가자";
  if (key === "state") return "상태";
  if (key.startsWith("position:")) return `${nameOf(key.slice(9))}의 포지션`;
  if (key.startsWith("rotation:")) return `팀 ${key.slice(9)} 서포터 차례 기록`;
  return key;
}

/**
 * 화면 6 — 기록. 운영자와 조회자가 같은 화면을 본다.
 * 표 대신 행 목록을 쓰고, 범위 선택은 목록 바로 위에 둔다.
 */
export function Records(props: {
  snapshot: Snapshot;
  openMatch: (id: string) => void;
  openPerson: (id: string) => void;
  openGraphs: () => void;
  onResult?: (match: MatchView) => void;
}) {
  const { snapshot } = props;
  // 최근 세션에 경기가 없으면 "오늘"이 비어 보이므로 전체로 연다.
  const [scope, setScope] = useState<Scope>(() =>
    matchesInScope(snapshot, { kind: "today" }).length > 0 ? { kind: "today" } : { kind: "all" },
  );
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const nameOf = nameMap(snapshot);
  const tz = snapshot.group.timezone;

  const season = scope.kind === "season" ? snapshot.seasons.find((s) => s.id === scope.seasonId) : null;
  const scopeLabel = scope.kind === "today" ? "오늘" : scope.kind === "all" ? "전체" : (season?.name ?? "시즌");
  const scoped = matchesInScope(snapshot, scope);
  const ordered = [...scoped].sort((a, b) => b.matchNo - a.matchNo);
  const listed = showAll ? ordered : ordered.slice(0, 30);
  const confirmed = scoped.filter((m) => m.state === "confirmed").length;
  const awaiting = scoped.filter((m) => m.state === "awaiting_result").length;
  const excluded = scoped.filter((m) => m.state === "excluded").length;

  // 배치는 범위와 무관하게 모임 전체 누적 기준이다.
  const placement = placements(snapshot.matches);
  // 순위는 배치 완료자를 먼저 둔다. 범위 안에 경기가 없는 사람은 순위에 없다.
  const ranked = sortRanking([...personRecords(scoped).values()], placement, nameOf);
  const rankOf = new Map(ranked.map((r, i) => [r.participantId, i + 1]));
  // 이름 검색은 일치도 순이고 배치 여부로 순서를 바꾸지 않는다. 순위 숫자는 그대로 보여준다.
  const records =
    query.trim() === ""
      ? ranked
      : searchByName(
          ranked.map((r) => ({ ...r, name: nameOf(r.participantId) })),
          query,
        );

  return (
    <div className="screen cols">
      <header className="screen-head">
        <h1>기록</h1>
        <button type="button" className="secondary" onClick={props.openGraphs}>
          그래프 분석
        </button>
      </header>

      <div className="segmented" role="group" aria-label="범위">
        <button
          type="button"
          aria-pressed={scope.kind === "today"}
          onClick={() => setScope({ kind: "today" })}
        >
          오늘
        </button>
        {snapshot.seasons.length > 0 && (
          <select
            aria-label="시즌 선택"
            className={scope.kind === "season" ? "chosen" : undefined}
            value={scope.kind === "season" ? scope.seasonId : ""}
            onChange={(e) => {
              if (e.target.value !== "") setScope({ kind: "season", seasonId: e.target.value });
            }}
          >
            <option value="">시즌</option>
            {snapshot.seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          aria-pressed={scope.kind === "all"}
          onClick={() => setScope({ kind: "all" })}
        >
          전체
        </button>
      </div>
      {season && (
        <p className="hint">
          {season.name}: {season.startsOn} ~ {season.endsOn}
        </p>
      )}

      <section aria-label="경기 목록">
        <h2>
          {scope.kind === "today" ? "오늘의 결과" : `${scopeLabel} 경기`} · {confirmed}경기 확정
          {awaiting > 0 ? ` · 결과 미입력 ${awaiting}` : ""}
          {excluded > 0 ? ` · 전적 제외 ${excluded}` : ""}
        </h2>
        {ordered.length === 0 ? (
          <p className="hint">이 범위에는 기록이 없어요.</p>
        ) : (
          <ul className="list">
            {listed.map((m) => (
              <li key={m.id} className="list-row static">
                <button type="button" className="row-main" onClick={() => props.openMatch(m.id)}>
                  <span>
                    {m.matchNo}경기 · {resultLine(m)}
                  </span>
                  <span className="hint">
                    {scope.kind !== "today" ? `${formatDate(m.playedAt, tz)} ` : ""}
                    {formatTime(m.confirmedAt ?? m.playedAt, tz)}
                  </span>
                </button>
                {m.state === "awaiting_result" && props.onResult && (
                  <button type="button" className="secondary" onClick={() => props.onResult!(m)}>
                    결과 입력
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {ordered.length > listed.length && (
          <button type="button" className="link" onClick={() => setShowAll(true)}>
            나머지 {ordered.length - listed.length}경기 더 보기
          </button>
        )}
      </section>

      <section aria-label="소환사 랭킹">
        <h2>소환사 랭킹 ({scopeLabel})</h2>
        <input
          type="search"
          aria-label="이름 검색"
          placeholder="이름 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {scope.kind !== "all" && query.trim() !== "" && records.length === 0 && (
          <p className="hint">
            <button type="button" className="link" onClick={() => setScope({ kind: "all" })}>
              전체 범위에서 찾기
            </button>
          </p>
        )}
        {ranked.length === 0 ? (
          <p className="hint">이 범위에는 확정된 경기가 없어요.</p>
        ) : records.length === 0 ? (
          <p className="hint">일치하는 이름이 없어요.</p>
        ) : (
          <ul className="list">
            {records.map((r) => {
              const p = placement.get(r.participantId);
              const rate = Math.round((r.wins / r.games) * 100);
              return (
                <li key={r.participantId}>
                  <button
                    type="button"
                    className="list-row"
                    onClick={() => props.openPerson(r.participantId)}
                  >
                    <span className="name">
                      <span className="rank">{rankOf.get(r.participantId)}</span>{" "}
                      {nameOf(r.participantId)}
                    </span>
                    <span className="stat">
                      {rate}% · {r.wins}승 {r.losses}패 ({r.games}경기)
                      {p && !p.done && (
                        <>
                          <br />
                          <span className="hint">
                            배치 진행 중 {p.games}/{PLACEMENT_GAMES} (누적 기준)
                          </span>
                        </>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="hint">
          순서: 배치 완료(누적 {PLACEMENT_GAMES}경기 이상) 먼저 → 승률 → 경기 수 → 이름. 이름을
          검색하면 일치하는 순으로 보여주고 순위 숫자는 바뀌지 않습니다. 결과 미입력·제외 경기는
          세지 않습니다.
        </p>
      </section>

      <details>
        <summary>변경 내역</summary>
        {snapshot.revisions.filter((r) => ["correction", "exclude", "restore"].includes(r.kind))
          .length === 0 ? (
          <p className="hint">정정·제외·복구한 기록이 없어요.</p>
        ) : (
          <ul className="list">
            {snapshot.revisions
              .filter((r) => ["correction", "exclude", "restore"].includes(r.kind))
              .map((r) => {
                const match = snapshot.matches.find((m) => m.id === r.matchId);
                return (
                  <li key={r.id}>
                    <button type="button" className="list-row" onClick={() => props.openMatch(r.matchId)}>
                      <span>
                        {r.matchNo}경기 · {REVISION_LABEL[r.kind] ?? r.kind}
                        {r.kind === "correction"
                          ? ` (${Object.keys(r.changes)
                              .map((k) => changeText(k, nameOf))
                              .join(", ")})`
                          : ""}
                        <br />
                        <span className="hint">현재: {match ? resultLine(match) : ""}</span>
                      </span>
                      <span className="hint">
                        {formatDate(r.createdAt, tz)} {formatTime(r.createdAt, tz)}
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        )}
        <p className="hint">
          수치가 달라 보이면 범위(오늘·전체)를 바꿨거나 위 목록처럼 경기 자체가 바뀐 것입니다.
        </p>
      </details>
    </div>
  );
}

type Editing = null | "winner" | "side" | "positions" | "participant" | "playedAt";

/** 경기 상세. 운영자에게는 항목 옆에 [수정]이 있다. 조회자는 읽기만 한다. */
export function MatchDetail(props: {
  snapshot: Snapshot;
  matchId: string;
  app: AppValue | null;
  back: () => void;
}) {
  const { snapshot, app } = props;
  const match = snapshot.matches.find((m) => m.id === props.matchId) ?? null;
  const nameOf = nameMap(snapshot);
  const tz = snapshot.group.timezone;
  const [editing, setEditing] = useState<Editing>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [side, setSide] = useState<Side | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [outId, setOutId] = useState<string | null>(null);
  const [playedInput, setPlayedInput] = useState("");

  if (!match) {
    return (
      <div className="screen">
        <button type="button" className="link" onClick={props.back}>
          ← 기록
        </button>
        <p>경기를 찾을 수 없어요.</p>
      </div>
    );
  }
  const operator = app !== null;
  const history = snapshot.revisions.filter((r) => r.matchId === match.id);
  const winnerSide = match.winnerTeam ? sideOfTeam(match.winnerTeam, match.teamASide) : null;

  function closeEdit() {
    setEditing(null);
    setPending(null);
    setSide(null);
    setPicked([]);
    setOutId(null);
    setError(null);
  }

  async function send(action: string, body: Record<string, unknown>) {
    if (!app) return;
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${snapshot.group.id}/matches/${match!.id}/${action}`, {
        requestId: newRequestId(),
        baseMatchVersion: match!.version,
        ...body,
      });
      await app.refreshAfterOwnChange();
      closeEdit();
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "ROTATION_DECISION_REQUIRED") {
        // 이 정정으로 서포터가 바뀐다. 차례 기록을 어떻게 할지 묻는다.
        setPending(body);
      } else {
        setError(e);
        if (e instanceof ApiFailure && e.code === "VERSION_CONFLICT") void app.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const sameTeam =
    picked.length === 2 &&
    match.roster.find((r) => r.participantId === picked[0])?.team ===
      match.roster.find((r) => r.participantId === picked[1])?.team;

  const inCandidates = snapshot.participants.filter(
    (p) => p.status === "active" && !match.roster.some((r) => r.participantId === p.id),
  );

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="link" onClick={props.back}>
          ← 기록
        </button>
        <h1>{match.matchNo}경기</h1>
        <span className="badge">{STATE_LABEL[match.state]}</span>
      </header>

      <p className="hint">
        {formatDate(match.playedAt, tz)} {formatTime(match.playedAt, tz)}
        {match.source === "backfill" ? " · 지난 경기 입력" : ""}
        {match.source === "import" ? " · 이관" : ""}
      </p>

      <MatchTeams
        match={match}
        nameOf={nameOf}
        sideOf={(team: Team) => {
          const s = sideOfTeam(team, match.teamASide);
          return s && s !== "unknown" ? SIDE_LABEL[s] : null;
        }}
      />

      {match.state === "confirmed" && (
        <ul className="list">
          <li className="list-row static">
            <span>승리 팀: 팀 {match.winnerTeam}</span>
            {operator && (
              <button type="button" className="secondary" onClick={() => setEditing("winner")}>
                수정
              </button>
            )}
          </li>
          <li className="list-row static">
            <span>승리 팀의 진영: {SIDE_LABEL[winnerSide ?? "unknown"]}</span>
            {operator && (
              <button type="button" className="secondary" onClick={() => setEditing("side")}>
                수정
              </button>
            )}
          </li>
          {operator && (
            <li className="list-row static">
              <span>
                경기 시각: {formatDate(match.playedAt, tz)} {formatTime(match.playedAt, tz)}
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  // 입력 칸은 이 기기의 현지 시각으로 채운다.
                  const d = new Date(match.playedAt);
                  const pad = (v: number) => String(v).padStart(2, "0");
                  setPlayedInput(
                    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
                  );
                  setEditing("playedAt");
                }}
              >
                수정
              </button>
            </li>
          )}
          {operator && (
            <li className="list-row static">
              <span>포지션·참가자</span>
              <span className="button-row">
                <button type="button" className="secondary" onClick={() => setEditing("positions")}>
                  포지션 수정
                </button>
                <button type="button" className="secondary" onClick={() => setEditing("participant")}>
                  참가자 교체
                </button>
              </span>
            </li>
          )}
        </ul>
      )}

      {operator && match.state === "awaiting_result" && (
        <button type="button" className="primary wide" onClick={() => setResultOpen(true)}>
          결과 입력
        </button>
      )}

      {operator && (match.state === "confirmed" || match.state === "awaiting_result") && (
        <details>
          <summary>더보기</summary>
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void send("exclude", {})}
            >
              전적 제외
            </button>
            <span className="hint">
              통계와 배치 판수에서 빠집니다. 서포터 차례는 그대로이고 언제든 복구할 수 있어요.
            </span>
          </div>
        </details>
      )}
      {operator && match.state === "excluded" && (
        <p className="note">
          전적에서 제외된 경기입니다.{" "}
          <button type="button" className="link" disabled={busy} onClick={() => void send("restore", {})}>
            복구
          </button>
        </p>
      )}
      {editing === null && <ErrorNote error={error} />}

      <details open={history.length > 0 && history.some((r) => r.kind === "correction")}>
        <summary>변경 이력 {history.length}건</summary>
        <ul className="list">
          {history.map((r) => (
            <li key={r.id} className="list-row static">
              <span>
                {REVISION_LABEL[r.kind] ?? r.kind}
                {Object.keys(r.changes).length > 0 && r.kind === "correction"
                  ? ` · ${Object.keys(r.changes)
                      .map((k) => changeText(k, nameOf))
                      .join(", ")}`
                  : ""}
              </span>
              <span className="hint">
                {formatDate(r.createdAt, tz)} {formatTime(r.createdAt, tz)}
              </span>
            </li>
          ))}
        </ul>
      </details>

      {resultOpen && (
        <ResultSheet
          match={match}
          mode="result"
          nameOf={nameOf}
          onClose={() => setResultOpen(false)}
        />
      )}
      {editing === "winner" && (
        <ResultSheet match={match} mode="correct" nameOf={nameOf} onClose={closeEdit} />
      )}

      {editing === "side" && (
        <Dialog title="진영 수정" onClose={closeEdit}>
          <p className="note">진영만 변경합니다. 개인 승패는 유지되고 진영 통계가 다시 계산됩니다.</p>
          <fieldset>
            <legend>이긴 팀 {match.winnerTeam}는 어느 진영이었나요?</legend>
            <div className="choice-row">
              {(["blue", "red", "unknown"] as const).map((value) => (
                <label key={value} className={side === value ? "choice chosen" : "choice"}>
                  <input
                    type="radio"
                    name="side"
                    checked={side === value}
                    onChange={() => setSide(value)}
                  />
                  <span>{value === "unknown" ? "기억나지 않음" : SIDE_LABEL[value]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <ErrorNote error={error} />
          <button
            type="button"
            className="primary wide"
            disabled={busy || side === null || side === winnerSide}
            onClick={() => void send("correct", { field: "side", winnerSide: side })}
          >
            {busy ? "저장 중" : "변경"}
          </button>
        </Dialog>
      )}

      {editing === "playedAt" && (
        <Dialog title="경기 시각 수정" onClose={closeEdit}>
          <p className="note">
            경기 시각만 변경합니다. 승패와 명단은 그대로이고, 이 경기가 다른 날이나 다른 시즌의
            기록으로 옮겨질 수 있습니다.
          </p>
          <label>
            경기 시각
            <input
              type="datetime-local"
              value={playedInput}
              onChange={(e) => setPlayedInput(e.target.value)}
            />
          </label>
          <ErrorNote error={error} />
          <button
            type="button"
            className="primary wide"
            disabled={busy || playedInput === "" || Number.isNaN(Date.parse(playedInput))}
            onClick={() =>
              void send("correct", {
                field: "playedAt",
                playedAt: new Date(playedInput).toISOString(),
              })
            }
          >
            {busy ? "저장 중" : "변경"}
          </button>
        </Dialog>
      )}

      {editing === "positions" && (
        <Dialog title="포지션 수정" onClose={closeEdit}>
          {pending ? (
            <RotationQuestion busy={busy} onAnswer={(fix) => void send("correct", { ...pending, fixRotation: fix })} />
          ) : (
            <>
              <p className="note">
                같은 팀의 두 사람을 고르면 포지션을 맞바꿉니다. 승패는 그대로이고 라인별 기록이 다시
                계산됩니다.
              </p>
              {(["A", "B"] as const).map((team) => (
                <ul key={team} className="list">
                  {teamRoster(match, team).map((r) => (
                    <li key={r.participantId}>
                      <button
                        type="button"
                        className={picked.includes(r.participantId) ? "list-row selected" : "list-row"}
                        aria-pressed={picked.includes(r.participantId)}
                        onClick={() =>
                          setPicked(
                            picked.includes(r.participantId)
                              ? picked.filter((id) => id !== r.participantId)
                              : [...picked, r.participantId].slice(-2),
                          )
                        }
                      >
                        팀 {team} · {r.position ? POSITION_LABEL[r.position] : "-"} ·{" "}
                        {nameOf(r.participantId)}
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
              {picked.length === 2 && !sameTeam && (
                <p className="note warn">같은 팀의 두 사람을 골라 주세요.</p>
              )}
              <ErrorNote error={error} />
              <button
                type="button"
                className="primary wide"
                disabled={busy || !sameTeam}
                onClick={() => {
                  const [a, b] = picked.map((id) => match.roster.find((r) => r.participantId === id)!);
                  if (!a || !b || !a.position || !b.position) return;
                  const positions: { participantId: string; position: Position }[] = [
                    { participantId: a.participantId, position: b.position },
                    { participantId: b.participantId, position: a.position },
                  ];
                  void send("correct", { field: "positions", positions });
                }}
              >
                {busy ? "저장 중" : "포지션 맞바꾸기"}
              </button>
            </>
          )}
        </Dialog>
      )}

      {editing === "participant" && (
        <Dialog title="참가자 교체" onClose={closeEdit}>
          {pending ? (
            <RotationQuestion busy={busy} onAnswer={(fix) => void send("correct", { ...pending, fixRotation: fix })} />
          ) : outId === null ? (
            <>
              <p className="note">기록에서 뺄 사람을 고르세요.</p>
              <ul className="list">
                {match.roster.map((r) => (
                  <li key={r.participantId}>
                    <button type="button" className="list-row" onClick={() => setOutId(r.participantId)}>
                      팀 {r.team} · {r.position ? POSITION_LABEL[r.position] : "-"} ·{" "}
                      {nameOf(r.participantId)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className="note">
                {nameOf(outId)}의 기록에서 이 경기가 빠지고, 고른 사람의 기록에 추가됩니다. 두 사람의
                배치 판수도 함께 바뀝니다. 나머지 9명은 그대로입니다.
              </p>
              {inCandidates.length === 0 ? (
                <p className="hint">바꿔 넣을 수 있는 참가자가 없어요.</p>
              ) : (
                <ul className="list">
                  {inCandidates.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        className="list-row"
                        disabled={busy}
                        onClick={() =>
                          void send("correct", {
                            field: "participant",
                            outParticipantId: outId,
                            inParticipantId: p.id,
                          })
                        }
                      >
                        {p.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <ErrorNote error={error} />
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}

function RotationQuestion(props: { busy: boolean; onAnswer: (fix: boolean) => void }) {
  return (
    <>
      <p>
        이 정정으로 이 경기의 서포터가 바뀝니다. 서포터 차례 기록도 함께 고칠까요?
      </p>
      <div className="button-row">
        <button type="button" className="primary" disabled={props.busy} onClick={() => props.onAnswer(true)}>
          함께 고치기
        </button>
        <button type="button" className="secondary" disabled={props.busy} onClick={() => props.onAnswer(false)}>
          차례 기록은 그대로
        </button>
      </div>
    </>
  );
}
