import { useRef, useState } from "react";
import {
  sideOfTeam,
  teamASideFromWinner,
  TEAMS,
  type MatchView,
  type Side,
  type Team,
} from "../../shared/types";
import { mutate, newRequestId } from "../api";
import { formatTime, SIDE_LABEL, TEAM_MARK, teamRoster } from "../format";
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
  // 요청 ID는 창을 열 때 한 번 만들고, 내용이 바뀌면 새로 만든다. 재시도에는 같은 값을 쓴다.
  const request = useRef<{ id: string; key: string } | null>(null);

  async function save() {
    if (!winner || !side || !app.groupId) return;
    const key = `${winner}:${side}`;
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
    const savedSide = sideOfTeam(saved.winnerTeam!, saved.teamASide);
    return (
      <Dialog title={title} onClose={props.onClose}>
        <p className="saved" role="status">
          <strong>
            {saved.matchNo}경기 저장됨 · 팀 {saved.winnerTeam} 승 · {SIDE_LABEL[savedSide ?? "unknown"]}
          </strong>
          <br />
          <span className="hint">{formatTime(new Date().toISOString())} 확인</span>
        </p>
        {props.afterSave?.(saved)}
      </Dialog>
    );
  }

  const teamASide = winner && side ? teamASideFromWinner(winner, side) : null;

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
                // 승리 팀을 바꾸면 진영 선택을 비운다.
                setSide(null);
              }}
            />
            <span>
              <strong>
                <span aria-hidden="true">{TEAM_MARK[team]}</span> 팀 {team}
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
          <legend>2/3 · 이긴 팀 {winner}는 어느 진영이었나요?</legend>
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
            {match.matchNo}경기 · 팀 {winner} 승 ·{" "}
            {teamASide === "unknown"
              ? "진영 미상"
              : `팀 A ${SIDE_LABEL[teamASide!]} / 팀 B ${SIDE_LABEL[sideOfTeam("B", teamASide)!]}`}
          </p>
          {side === "unknown" && (
            <p className="hint">개인 승패는 기록되고 진영 통계에서만 빠집니다.</p>
          )}
        </section>
      )}

      <ErrorNote error={error} onCheck={() => void save()} />
      <button
        type="button"
        className="primary wide"
        disabled={!winner || !side || busy}
        onClick={() => void save()}
      >
        {busy ? "저장 중" : "저장"}
      </button>
    </Dialog>
  );
}
