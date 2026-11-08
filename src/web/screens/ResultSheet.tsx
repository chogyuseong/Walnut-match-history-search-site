import { useRef, useState } from "react";
import {
  presetWinnerSide,
  teamASideFromWinner,
  TEAMS,
  type MatchView,
  type Side,
  type Team,
} from "../../shared/types";
import { normalizeMemo } from "../../shared/memo";
import { mutate, newRequestId } from "../api";
import { MemoField, memoTooLong } from "../memoField";
import { formatTime, TEAM_MARK, teamBoxClass, teamName, teamRoster, winnerText } from "../format";
import { Dialog, ErrorNote } from "../ui";
import { useAppValue } from "../useApp";

const SIDE_CHOICES: { value: Side; label: string }[] = [
  { value: "blue", label: "블루" },
  { value: "red", label: "레드" },
  { value: "unknown", label: "기억나지 않음" },
];

/**
 * 화면 5 — 결과 입력 창(docs/P2 P2-7).
 * ① 명단을 보고 승리 팀 선택 → ② 승리 팀의 실제 진영 → ③ 요약 확인 후 저장.
 * 진영은 미리 선택돼 있지 않고, 승리 팀을 바꾸면 진영을 다시 묻는다.
 * 단, 준비 화면에서 시작한 경기(팀 A = 블루팀)처럼 진영이 정해진 경기의 결과 입력은 "블루팀 승"/"레드팀 승" 큰 버튼 두 개로
 * 고르고(한 손 조작) 진영은 그 값으로 미리 골라 둔다. 진영 정정은 "진영이 시작할 때와 달랐나요?" 접힘 영역에 있다
 * (2026-11-07 재배치. 저장 내용·요청은 예전과 같다). 진영을 모르는 예전 경기(팀 A/B)와 승리 팀 정정은 예전 3단계 그대로다.
 * mode가 "correct"면 확정 경기의 승리 팀 정정이다.
 */
export function ResultSheet(props: {
  match: MatchView;
  mode: "result" | "correct";
  nameOf: (id: string) => string;
  onClose: () => void;
  onSaved?: (match: MatchView) => void;
  /** 저장 뒤 같은 자리에 보여줄 다음 행동. */
  afterSave?: (match: MatchView) => React.ReactNode;
}) {
  const app = useAppValue();
  const { match, nameOf } = props;
  const [winner, setWinner] = useState<Team | null>(null);
  const [side, setSide] = useState<Side | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<MatchView | null>(null);
  // 메모(선택 칸, 결과 입력에서만). 이미 쓴 메모가 있으면 그대로 채워 둔다.
  const [memo, setMemo] = useState(match.memo ?? "");
  const memoValue = normalizeMemo(memo);
  const memoChanged = props.mode === "result" && memoValue !== (match.memo ?? null);
  // 요청 ID는 창을 열 때 한 번 만들고, 내용이 바뀌면 새로 만든다. 재시도에는 같은 값을 쓴다.
  const request = useRef<{ id: string; key: string } | null>(null);

  async function save() {
    if (!winner || !side || !app.groupId || memoTooLong(memo)) return;
    const key = `${winner}:${side}:${memoChanged ? (memoValue ?? "") : "-"}`;
    if (!request.current || request.current.key !== key) {
      request.current = { id: newRequestId(), key };
    }
    setBusy(true);
    setError(null);
    try {
      const path =
        props.mode === "result"
          ? `/api/groups/${app.groupId}/matches/${match.id}/result`
          : `/api/groups/${app.groupId}/matches/${match.id}/correct`;
      const body =
        props.mode === "result"
          ? {
              requestId: request.current.id,
              baseMatchVersion: match.version,
              winnerTeam: winner,
              winnerSide: side,
              // 메모는 바꿨을 때만 보낸다(빈 글 = 지우기).
              ...(memoChanged ? { memo: memoValue ?? "" } : {}),
            }
          : {
              requestId: request.current.id,
              baseMatchVersion: match.version,
              field: "winner",
              winnerTeam: winner,
              winnerSide: side,
            };
      const result = await mutate<{ match: MatchView }>(path, body);
      setSaved(result.match);
      await app.refreshAfterOwnChange();
      props.onSaved?.(result.match);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const title = `${match.matchNo}경기 ${props.mode === "result" ? "결과" : "승리 팀 수정"}`;

  if (saved) {
    return (
      <Dialog title={title} onClose={props.onClose}>
        <p className="saved" role="status">
          <strong>
            {saved.matchNo}경기 저장됨 · {winnerText(saved.winnerTeam!, saved.teamASide)}
          </strong>
          <br />
          <span className="hint">{formatTime(new Date().toISOString())} 확인</span>
        </p>
        {props.afterSave?.(saved)}
      </Dialog>
    );
  }

  const teamASide = winner && side ? teamASideFromWinner(winner, side) : null;
  // 진영 단계에서 시작 때와 반대로 고쳤는지(정해진 진영이 있을 때만).
  const flipped =
    teamASide !== null &&
    teamASide !== "unknown" &&
    (match.teamASide === "blue" || match.teamASide === "red") &&
    teamASide !== match.teamASide;

  // 진영이 정해진 경기의 결과 입력(2026-11-07): "블루팀 승 / 레드팀 승" 큰 버튼 두 개로 고르고 바로 저장한다.
  // 진영 정정은 접힘 영역으로 내렸다. 보내는 내용(승리 팀 + 승리 팀의 진영)과 요청은 예전과 같다.
  const quick = props.mode === "result" && presetWinnerSide("A", match.teamASide) !== null;
  if (quick) {
    return (
      <Dialog title={title} onClose={props.onClose}>
        <div className="result-pick" role="group" aria-label="어느 팀이 이겼나요?">
          {TEAMS.map((team) => (
            <button
              key={team}
              type="button"
              className={`result-pick-btn ${teamBoxClass(team, match.teamASide)}`}
              aria-pressed={winner === team}
              onClick={() => {
                setWinner(team);
                // 승리 팀을 바꾸면 진영을 그 팀의 시작 진영으로 다시 채운다(접힘 영역에서 고친 값은 버린다).
                setSide(presetWinnerSide(team, match.teamASide));
              }}
            >
              <strong className="result-pick-title">
                <span aria-hidden="true">{TEAM_MARK[team]}</span> {teamName(team, match.teamASide)} 승
                {winner === team && <span className="tag">선택</span>}
              </strong>
              <span className="hint result-pick-names">
                {teamRoster(match, team)
                  .map((r) => nameOf(r.participantId))
                  .join(" · ")}
              </span>
            </button>
          ))}
        </div>

        {winner && side && (
          <section aria-label="요약">
            <p>
              <strong>
                {match.matchNo}경기 · {winnerText(winner, teamASide)}
              </strong>
            </p>
            {flipped && (
              <p className="hint">
                시작할 때와 진영이 반대예요. 저장하면 {TEAM_MARK.A} 쪽이 {teamName("A", teamASide)}, {TEAM_MARK.B} 쪽이{" "}
                {teamName("B", teamASide)}이 돼요.
              </p>
            )}
            {side === "unknown" && <p className="hint">개인 승패는 기록되고 진영 통계에서만 빠집니다.</p>}
          </section>
        )}

        {winner && (
          <details className="result-side">
            <summary>진영이 시작할 때와 달랐나요?</summary>
            <fieldset>
              <legend>이긴 팀({teamName(winner, match.teamASide)})은 실제로 어느 진영이었나요?</legend>
              <p className="hint">시작할 때 정한 진영으로 미리 골라 뒀어요. 실제와 다르면 바꿔 주세요.</p>
              <div className="choice-row">
                {SIDE_CHOICES.map((choice) => (
                  <label key={choice.value} className={side === choice.value ? "choice chosen" : "choice"}>
                    <input
                      type="radio"
                      name="side"
                      checked={side === choice.value}
                      onChange={() => setSide(choice.value)}
                    />
                    <span>{choice.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </details>
        )}

        {winner && <MemoField value={memo} onChange={setMemo} />}

        <ErrorNote error={error} onCheck={() => void save()} />
        <button
          type="button"
          className="primary wide"
          disabled={!winner || !side || busy || memoTooLong(memo)}
          onClick={() => void save()}
        >
          {busy ? "저장 중" : "저장"}
        </button>
      </Dialog>
    );
  }

  return (
    <Dialog title={title} onClose={props.onClose}>
      {props.mode === "correct" && (
        <p className="note">
          승리 팀을 바꾸면 10명의 승패가 서로 바뀝니다. 진영을 다시 확인해 주세요.
        </p>
      )}
      <fieldset>
        <legend>1/3 · 어느 팀이 이겼나요?</legend>
        {TEAMS.map((team) => (
          <label key={team} className={winner === team ? "choice chosen" : "choice"}>
            <input
              type="radio"
              name="winner"
              checked={winner === team}
              onChange={() => {
                setWinner(team);
                // 승리 팀을 바꾸면 진영 선택을 비운다. 시작 때 고른 진영이 있으면 그 팀의 진영으로 다시 채운다.
                setSide(props.mode === "result" ? presetWinnerSide(team, match.teamASide) : null);
              }}
            />
            <span>
              <strong>
                <span aria-hidden="true">{TEAM_MARK[team]}</span> {teamName(team, match.teamASide)}
                {presetWinnerSide(team, match.teamASide) !== null ? " 승" : ""}
              </strong>
              <br />
              <span className="hint">
                {teamRoster(match, team)
                  .map((r) => nameOf(r.participantId))
                  .join(" · ")}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {winner && (
        <fieldset>
          <legend>2/3 · 이긴 팀({teamName(winner, match.teamASide)})은 실제로 어느 진영이었나요?</legend>
          {props.mode === "result" && presetWinnerSide(winner, match.teamASide) !== null && (
            <p className="hint">시작할 때 정한 진영으로 미리 골라 뒀어요. 실제와 다르면 바꿔 주세요.</p>
          )}
          <div className="choice-row">
            {SIDE_CHOICES.map((choice) => (
              <label key={choice.value} className={side === choice.value ? "choice chosen" : "choice"}>
                <input
                  type="radio"
                  name="side"
                  checked={side === choice.value}
                  onChange={() => setSide(choice.value)}
                />
                <span>{choice.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {winner && side && (
        <section aria-label="요약">
          <h3>3/3 · 확인</h3>
          <p>
            {match.matchNo}경기 · {winnerText(winner, teamASide)}
          </p>
          {flipped && (
            <p className="hint">
              시작할 때와 진영이 반대예요. 저장하면 {TEAM_MARK.A} 쪽이 {teamName("A", teamASide)}, {TEAM_MARK.B} 쪽이{" "}
              {teamName("B", teamASide)}이 돼요.
            </p>
          )}
          {side === "unknown" && (
            <p className="hint">개인 승패는 기록되고 진영 통계에서만 빠집니다.</p>
          )}
          {props.mode === "result" && <MemoField value={memo} onChange={setMemo} />}
        </section>
      )}

      <ErrorNote error={error} onCheck={() => void save()} />
      <button
        type="button"
        className="primary wide"
        disabled={!winner || !side || busy || memoTooLong(memo)}
        onClick={() => void save()}
      >
        {busy ? "저장 중" : "저장"}
      </button>
    </Dialog>
  );
}
