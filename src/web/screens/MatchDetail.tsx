// 경기 상세: 팀 판, 예상 승률, 이 경기로 바뀐 MMR, 메모·시리즈, 변경 내역, 운영자의 정정·삭제 대화상자.
// 기록 화면에서 경기를 누르면 열린다. 운영자는 operator.ts 묶음, 모임 링크는 Viewer.tsx가 불러온다.
import { useMemo, useRef, useState } from "react";
import {
  computeRatings,
  matchRatingChanges,
  shownRating,
  ratingOptionsOf,
  signedDelta,
  STREAK_K_START,
} from "../../shared/rating";
import { fractionPercent, zonedDateTimeInput, zonedInputToUtc } from "../../shared/stats";
import {
  POSITIONS,
  sideOfTeam,
  type MatchView,
  type Position,
  type Side,
  type Snapshot,
  type Team,
} from "../../shared/types";
import { championName } from "../../shared/champions";
import { ApiFailure, mutate, newRequestId } from "../api";
import { ChampionFields } from "../championPicker";
import { ChampionPortrait } from "../championPortrait";
import {
  formatDate,
  formatTime,
  nameMap,
  POSITION_LABEL,
  SIDE_LABEL,
  STATE_LABEL,
  teamName,
  teamRoster,
} from "../format";
import { laneRivalMeetings } from "../../shared/headToHead";
import { LANE_RIVAL_BASIS, useExpectations, useLaneRivals } from "../matchCard";
import { laneRivalTitle, RivalBadge } from "../rankBadges";
import { expectedOf, UPSET_MMR_GAP, type MatchExpectation } from "../../shared/upset";
import { MatchMemoSection } from "../memoField";
import { MatchSeriesSection } from "../seriesPanel";
import { drawMatchImage, fileDate, ShareImageDialog } from "../shareImage";
import { BackLink, Help, MatchTeams } from "../screenKit";
import { Dialog, ErrorNote } from "../ui";
import type { AppValue } from "../useApp";
import { ResultSheet } from "./ResultSheet";
import { changeText, DELETED_BY_LABEL, deletionOf, REVISION_LABEL } from "./revisionText";

type Editing = null | "winner" | "side" | "positions" | "participant" | "playedAt" | "champions";

/** 경기의 챔피언 기록({ 참가자 ID: 챔피언 키 }, 고른 사람만). 챔피언 저장 요청의 본문 모양이다. */
function championsOf(match: MatchView): Record<string, string> {
  return Object.fromEntries(match.roster.flatMap((r) => (r.champion ? [[r.participantId, r.champion]] : [])));
}

function sameChampions(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** 경기 상세 목록 줄의 요약: "기록 없음" 또는 "10명 중 4명". 이름별 챔피언은 위의 팀 판에 있다. */
function championSummary(match: MatchView): string {
  const count = match.roster.filter((r) => r.champion).length;
  return count === 0 ? "기록 없음" : `${match.roster.length}명 중 ${count}명`;
}

/**
 * 경기 전 예상 한 줄(이변 지수, src/shared/upset.ts): "경기 전 예상 블루 62% : 레드 38%"와 이변 배지.
 * 진영을 모르면 팀 A·B로 쓴다. 예상이 없으면(유효 확정 경기가 아님) 줄을 그리지 않고,
 * 열 명 모두 배치 중이면 숫자 대신 "예상 없음"을 쓴다(판정하지 않음).
 */
function ExpectationLine(props: { expectation: MatchExpectation | undefined }) {
  const e = props.expectation;
  if (!e) return null;
  if (!e.reliable) {
    return <p className="hint">경기 전 예상 없음 · 열 명 모두 배치 중이라 판정하지 않아요</p>;
  }
  // 블루를 앞에 둔다. 앞쪽 숫자를 반올림하고 뒤쪽은 100 − 앞쪽(합이 101%가 되지 않게).
  const first: Team = e.teamASide === "red" ? "B" : "A";
  const second: Team = first === "A" ? "B" : "A";
  const firstPct = fractionPercent(expectedOf(e, first));
  const upsetRule = `이긴 쪽의 팀 평균 MMR이 ${shownRating(e.winnerDeficit)}점 낮았어요(${UPSET_MMR_GAP}점 이상 낮은 팀이 이기면 이변)`;
  return (
    <>
      <p className="hint expectation-line">
        경기 전 예상 {teamName(first, e.teamASide).replace(/팀$/, "")} {firstPct}% :{" "}
        {teamName(second, e.teamASide).replace(/팀$/, "")} {100 - firstPct}%
        {e.upset && (
          <>
            {" "}
            <span className="series-badge" title={upsetRule}>
              이변
            </span>
          </>
        )}
        {/* F6(2026-11-10): 그때 화면에 떴던 값이 아니다. 뒤에 정정하거나 설정을 바꾸면 이 값도 바뀐다. */}
        <span className="expectation-note"> · 지금 기록과 설정으로 다시 계산한 값</span>
      </p>
      {/* 이변 배지의 기준은 title 풍선이라 터치 화면에서 보이지 않아 접힌 도움말에도 둔다. */}
      {e.upset && (
        <Help label="이변 기준">
          {/* 판정은 점수, %는 보정 확률로 나눈 이유: upset.ts 머리 주석. */}
          {upsetRule}. 목록의 "이변" 배지도 같은 기준이고, 모든 모임이 같은 점수로 판정해요. 위의 %는 팀 MMR 차로 구한
          승률을 이 모임 지난 경기 결과에 맞춰 보정한 값이라(준비 화면 예상 승률과 같은 방식) 이변 경기도 50%에 가깝게 나올 수 있어요.
        </Help>
      )}
    </>
  );
}

/**
 * 경기 상세 "이 경기로 바뀐 MMR": 이 경기 하나가 열 명에게 낸 전·후 값(src/shared/rating.ts matchRatingChanges).
 * 결과 저장 뒤의 다음 행동을 밀어내지 않게 접어 둔다. 진 쪽 큰 감점이 탓하기 소재가 되지 않도록, 같은 팀은 같은 방향이고
 * 폭은 판수·연속 결과로만 갈린다는 설명을 함께 둔다. 변화는 반올림한 전·후 값의 차라 표의 두 숫자와 늘 맞는다.
 */
/** 변화 글자색(사용자 요청, CLAUDE.md 5절 예외): 오르면 빨강, 내리면 파랑, 0은 기본색. 부호(+·−)를 늘 같이 둔다. */
function deltaClass(delta: number): string {
  if (delta > 0) return "rc-up";
  if (delta < 0) return "rc-down";
  return "";
}

function RatingChanges(props: { snapshot: Snapshot; match: MatchView; nameOf: (id: string) => string }) {
  const { snapshot, match } = props;
  const changes = useMemo(
    () => matchRatingChanges(computeRatings(snapshot.matches, ratingOptionsOf(snapshot.group.settings)), match),
    [snapshot, match],
  );
  if (changes.length === 0) return null;
  // 위 팀 상자와 같은 탑→서폿 순서. 포지션이 없는 경기(지난 경기 입력·이관)는 명단 순서 그대로 뒤에 둔다.
  const positionOf = new Map(match.roster.map((r) => [r.participantId, r.position]));
  const order = (id: string) => {
    const position = positionOf.get(id);
    return position ? POSITIONS.indexOf(position) : POSITIONS.length;
  };
  const sorted = changes.toSorted((a, b) => order(a.participantId) - order(b.participantId));
  const teams: Team[] = match.teamASide === "red" ? ["B", "A"] : ["A", "B"];
  return (
    <details className="rating-changes">
      <summary>이 경기로 바뀐 MMR</summary>
      <p className="hint">
        같은 팀은 같은 방향으로 움직여요. 폭은 판수가 적을수록, {STREAK_K_START}연승·연패부터 이어질수록 커져요. 지금 기록과
        설정으로 다시 계산한 값이라 앞 경기를 고치면 바뀌어요.
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">이름</th>
            <th scope="col" className="num">
              경기 전
            </th>
            <th scope="col" className="num">
              경기 후
            </th>
            <th scope="col" className="num">
              변화
            </th>
          </tr>
        </thead>
        {teams.map((team) => (
          <tbody key={team}>
            <tr>
              <th scope="colgroup" colSpan={4}>
                {teamName(team, match.teamASide)} · {team === match.winnerTeam ? "승리" : "패배"}
              </th>
            </tr>
            {sorted
              .filter((c) => c.team === team)
              .map((c) => (
                <tr key={c.participantId}>
                  <td>
                    {props.nameOf(c.participantId)}
                    {c.multiplier > 1 && (
                      <span className="rc-streak">
                        {" "}
                        · {c.run}
                        {team === match.winnerTeam ? "연승" : "연패"}
                      </span>
                    )}
                  </td>
                  <td className="num">{shownRating(c.before)}</td>
                  <td className="num">{shownRating(c.after)}</td>
                  <td className={`num ${deltaClass(shownRating(c.after) - shownRating(c.before))}`}>
                    {signedDelta(shownRating(c.after) - shownRating(c.before))}
                  </td>
                </tr>
              ))}
          </tbody>
        ))}
      </table>
    </details>
  );
}

/** 경기 상세. 운영자에게는 항목 옆에 [수정]이 있다. 조회자는 읽기만 한다. */
export function MatchDetail(props: {
  snapshot: Snapshot;
  matchId: string;
  app: AppValue | null;
  back: () => void;
  /** 같은 시리즈의 다른 판으로 간다. */
  openMatch: (id: string) => void;
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
  // 챔피언 수정 창에서 고르는 중인 값({ 참가자 ID: 챔피언 키 }).
  const [championDraft, setChampionDraft] = useState<Record<string, string>>({});
  const [imageOpen, setImageOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const expectationOf = useExpectations(snapshot);
  const laneRivals = useLaneRivals(snapshot);
  // 요청 ID는 같은 요청(동작·내용·경기 버전)을 다시 보낼 때 같은 값을 쓴다. 성공하거나 내용이 바뀌면 새로 만든다.
  const request = useRef<{ id: string; key: string } | null>(null);

  if (!match) {
    return (
      <div className="screen">
        <BackLink label="← 기록" fallback={props.back} />
        <h1>경기를 찾을 수 없어요</h1>
        <p>지워졌거나 주소가 잘못 적혔을 수 있어요.</p>
        <button type="button" className="primary" onClick={props.back}>
          기록으로
        </button>
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
    const key = `${match!.id}:${match!.version}:${action}:${JSON.stringify(body)}`;
    if (!request.current || request.current.key !== key) request.current = { id: newRequestId(), key };
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${snapshot.group.id}/matches/${match!.id}/${action}`, {
        requestId: request.current.id,
        baseMatchVersion: match!.version,
        ...body,
      });
      request.current = null;
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

  /**
   * 경기 삭제(src/server/matchRemoval.ts deleteMatch). 성공하면 기록 화면으로 먼저 돌아간 뒤 새로 읽는다: 새로 읽은 다음에
   * 돌아가면 그 사이 이 화면이 "경기를 찾을 수 없어요"로 한 번 그려진다.
   */
  async function deleteThisMatch() {
    if (!app) return;
    const key = `${match!.id}:${match!.version}:delete`;
    if (!request.current || request.current.key !== key) request.current = { id: newRequestId(), key };
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${snapshot.group.id}/matches/${match!.id}/delete`, {
        requestId: request.current.id,
        baseMatchVersion: match!.version,
      });
      request.current = null;
      app.setNotice(`${match!.matchNo}경기를 지웠어요. 기록 화면의 변경 내역에서 되살릴 수 있어요.`);
      props.back();
      await app.refreshAfterOwnChange();
    } catch (e) {
      setError(e);
      if (e instanceof ApiFailure && e.code === "VERSION_CONFLICT") void app.refresh();
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
        <BackLink label="← 기록" fallback={props.back} />
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
        championName={championName}
        championPortrait={(key) => <ChampionPortrait championKey={key} size={32} />}
        badgeOf={(id) => {
          // 같은 라인 맞은편에게 개인 통계 기준 가장 어려운 상대인 쪽에만(matchCard.tsx useLaneRivals, 지금까지 누적).
          const meeting = laneRivalMeetings(match.roster, laneRivals).find((m) => m.strongId === id);
          return meeting ? (
            <RivalBadge
              title={`${laneRivalTitle(meeting.position, nameOf(meeting.weakId), meeting.rival)} (${LANE_RIVAL_BASIS})`}
            />
          ) : null;
        }}
      />

      <ExpectationLine expectation={expectationOf.get(match.id)} />
      <RatingChanges snapshot={snapshot} match={match} nameOf={nameOf} />

      {match.state === "confirmed" && (
        <div className="button-row">
          <button type="button" className="secondary" onClick={() => setImageOpen(true)}>
            결과 이미지
          </button>
        </div>
      )}
      {imageOpen && (
        <ShareImageDialog
          title={`${match.matchNo}경기 결과 이미지`}
          fileName={`${match.matchNo}경기-${fileDate(match.playedAt, tz)}.png`}
          make={() => drawMatchImage(snapshot, match)}
          onClose={() => setImageOpen(false)}
        />
      )}

      {match.state === "confirmed" && (
        <ul className="list list-card">
          <li className="list-row static">
            <span>승리 팀: {teamName(match.winnerTeam!, match.teamASide)}</span>
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
                  // 입력 칸은 화면에 보이는 시각과 같은 모임 시간대로 채운다(기기 시간대가 아니다).
                  setPlayedInput(zonedDateTimeInput(match.playedAt, tz));
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
          {operator && (
            <li className="list-row static">
              <span>챔피언: {championSummary(match)}</span>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setChampionDraft(championsOf(match));
                  setEditing("champions");
                }}
              >
                <span aria-hidden="true">{match.roster.some((r) => r.champion) ? "수정" : "기록"}</span>
                <span className="sr-only">{match.roster.some((r) => r.champion) ? "챔피언 수정" : "챔피언 기록"}</span>
              </button>
            </li>
          )}
        </ul>
      )}

      {operator && match.state === "awaiting_result" && (
        <button type="button" className="primary wide" onClick={() => setResultOpen(true)}>
          결과 입력
        </button>
      )}

      {operator && (match.state === "confirmed" || match.state === "awaiting_result" || match.state === "excluded") && (
        <details>
          <summary>더보기</summary>
          {match.state !== "excluded" && (
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
                통계와 배치 판수에서 빠져요. 서포터 횟수는 그대로이고 언제든 복구할 수 있어요.
              </span>
            </div>
          )}
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                setError(null);
                setDeleteOpen(true);
              }}
            >
              경기 삭제
            </button>
            <span className="hint">
              잘못 넣은 경기를 지워요. 목록과 통계에서 사라지고, 변경 내역에서 되살릴 수 있어요.
            </span>
          </div>
        </details>
      )}
      {operator && match.state === "excluded" && (
        <p className="note">
          전적에서 제외된 경기예요.{" "}
          <button type="button" className="link" disabled={busy} onClick={() => void send("restore", {})}>
            복구
          </button>
        </p>
      )}
      {editing === null && !deleteOpen && <ErrorNote error={error} />}
      {deleteOpen && (
        <Dialog title={`${match.matchNo}경기 삭제`} onClose={() => setDeleteOpen(false)}>
          <p>
            {formatDate(match.playedAt, tz)} {formatTime(match.playedAt, tz)} · {STATE_LABEL[match.state]}
          </p>
          <MatchTeams match={match} nameOf={nameOf} />
          <p className="note">
            목록·랭킹·통계와 모임 링크에서 사라져요. 경기 번호는 비워 두고, 기록 화면의 변경 내역에서 되살릴 수 있어요.
          </p>
          <ErrorNote error={error} />
          <div className="button-row">
            <button type="button" className="danger" disabled={busy} onClick={() => void deleteThisMatch()}>
              {busy ? "지우는 중" : "삭제"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setDeleteOpen(false)}>
              그만두기
            </button>
          </div>
        </Dialog>
      )}

      <MatchMemoSection key={`memo-${match.id}`} match={match} app={app} />
      <MatchSeriesSection
        key={`series-${match.id}`}
        snapshot={snapshot}
        match={match}
        app={app}
        nameOf={nameOf}
        openMatch={props.openMatch}
      />

      {/* 이력이 없으면 펼칠 것도 없는 접힘 상자 대신 한 줄로 알린다. */}
      {history.length === 0 ? (
        <p className="hint">변경 이력 없음</p>
      ) : (
        <details open={history.some((r) => r.kind === "correction")}>
          <summary>변경 이력 {history.length}건</summary>
          <ul className="list">
            {history.map((r) => (
              <li key={r.id} className="list-row static">
                <span>
                  {deletionOf(r) !== null
                    ? `${deletionOf(r) ? "삭제" : "삭제 되살림"} · ${DELETED_BY_LABEL[String(r.changes.by?.to)] ?? "운영자"}`
                    : (REVISION_LABEL[r.kind] ?? r.kind) +
                      (Object.keys(r.changes).length > 0 && r.kind === "correction"
                        ? ` · ${Object.keys(r.changes)
                            .map((k) => changeText(k, nameOf, match))
                            .join(", ")}`
                        : "")}
                </span>
                <span className="hint">
                  {formatDate(r.createdAt, tz)} {formatTime(r.createdAt, tz)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

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
          <p className="note">진영만 변경해요. 개인 승패는 유지되고 진영 통계가 다시 계산돼요.</p>
          <fieldset>
            <legend>
              이긴 팀({teamName(match.winnerTeam!, match.teamASide)})은 실제로 어느 진영이었나요?
            </legend>
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
            {busy ? "저장 중" : "진영 저장"}
          </button>
        </Dialog>
      )}

      {editing === "playedAt" && (
        <Dialog title="경기 시각 수정" onClose={closeEdit}>
          <p className="note">
            경기 시각만 변경해요. 승패와 명단은 그대로이고, 이 경기가 다른 날이나 다른 시즌의
            기록으로 옮겨질 수 있어요.
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
            disabled={busy || zonedInputToUtc(playedInput, tz) === null}
            onClick={() => {
              // 입력값은 모임 시간대의 시각으로 해석한다.
              const playedAt = zonedInputToUtc(playedInput, tz);
              if (playedAt) void send("correct", { field: "playedAt", playedAt });
            }}
          >
            {busy ? "저장 중" : "시각 저장"}
          </button>
        </Dialog>
      )}

      {editing === "champions" && (
        <Dialog title="챔피언 기록" onClose={closeEdit}>
          <p className="note">승패와 통계는 그대로예요. 모임 링크에서도 보여요.</p>
          <ChampionFields
            match={match}
            nameOf={nameOf}
            history={snapshot.matches}
            value={championDraft}
            onChange={setChampionDraft}
          />
          <ErrorNote error={error} />
          <button
            type="button"
            className="primary wide"
            disabled={busy || sameChampions(championDraft, championsOf(match))}
            onClick={() => void send("champions", { champions: championDraft })}
          >
            {busy ? "저장 중" : "챔피언 저장"}
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
                같은 팀의 두 사람을 고르면 포지션을 맞바꿔요. 승패는 그대로이고 라인별 기록이 다시
                계산돼요.
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
                        {teamName(team, match.teamASide)} · {r.position ? POSITION_LABEL[r.position] : "-"} ·{" "}
                        {nameOf(r.participantId)}
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
              {picked.length === 2 && !sameTeam && (
                <p className="note error">같은 팀의 두 사람을 골라 주세요.</p>
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
                      {teamName(r.team, match.teamASide)} · {r.position ? POSITION_LABEL[r.position] : "-"} ·{" "}
                      {nameOf(r.participantId)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className="note">
                {nameOf(outId)}의 기록에서 이 경기가 빠지고, 고른 사람의 기록에 추가돼요. 두 사람의
                배치 판수도 함께 바뀌어요. 나머지 9명은 그대로예요.
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
        이 정정으로 이 경기의 서포터가 바뀌어요. 서포터 횟수 기록도 함께 고칠까요?
      </p>
      <div className="button-row">
        <button type="button" className="primary" disabled={props.busy} onClick={() => props.onAnswer(true)}>
          함께 고치기
        </button>
        <button type="button" className="secondary" disabled={props.busy} onClick={() => props.onAnswer(false)}>
          횟수 기록은 그대로
        </button>
      </div>
    </>
  );
}
