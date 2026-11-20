import { Suspense, useEffect, useRef, useState } from "react";
import {
  presetWinnerSide,
  teamASideFromWinner,
  TEAMS,
  type MatchView,
  type Side,
  type Team,
} from "../../shared/types";
import { normalizeMemo } from "../../shared/memo";
import { ApiFailure, mutate, newRequestId } from "../api";
import { MemoField, memoTooLong } from "../memoField";
import { formatTime, TEAM_MARK, teamBoxClass, teamName, teamRoster, winnerText } from "../format";
import { ChampionFields } from "../lazyScreens";
import { clearResultDraft, loadResultDraft, saveResultDraft, type LoadedResultDraft } from "../resultDraft";
import { Dialog, ErrorNote } from "../ui";
import { go, useAppValue } from "../useApp";

const SIDE_CHOICES: { value: Side; label: string }[] = [
  { value: "blue", label: "블루" },
  { value: "red", label: "레드" },
  { value: "unknown", label: "기억나지 않음" },
];

/** 이긴 팀의 실제 진영 라디오 묶음. 큰 버튼 화면의 접힘 영역과 예전 3단계 화면이 같은 것을 쓴다. */
function SideChoices(props: { side: Side | null; onChange: (side: Side) => void }) {
  return (
    <div className="choice-row">
      {SIDE_CHOICES.map((choice) => (
        <label key={choice.value} className={props.side === choice.value ? "choice chosen" : "choice"}>
          <input
            type="radio"
            name="side"
            checked={props.side === choice.value}
            onChange={() => props.onChange(choice.value)}
          />
          <span>{choice.label}</span>
        </label>
      ))}
    </div>
  );
}

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
  // 챔피언(선택, 결과 입력에서만). 접힌 영역을 펼쳐 한 명이라도 골랐을 때만 보낸다: 쓰지 않는 모임의 요청은 예전과 같다.
  const [championsOpen, setChampionsOpen] = useState(false);
  const [champions, setChampions] = useState<Record<string, string>>({});
  const championCount = Object.keys(champions).length;
  // 이 기기에 남은 작성 중 내용(결과 입력만, resultDraft.ts). 이어 쓸지 버릴지 고르기 전까지는 덮어쓰지 않는다.
  // 열자마자 저절로 채우지 않고 묻는 것은, 다른 운영자가 그 사이 같은 경기를 다르게 본 경우 옛 입력을 모르고 저장하지 않게 하려는 것이다.
  // hasInput: 창을 연 뒤 실제로 무언가 고르거나 쓴 경우만 남긴다(빈 창을 열고 닫기만 하면 아무것도 남기지 않는다).
  const [leftover, setLeftover] = useState<LoadedResultDraft | null>(() =>
    props.mode === "result" && app.groupId ? loadResultDraft(app.groupId, match.id) : null,
  );
  const hasInput = winner !== null || memo !== (match.memo ?? "") || championCount > 0;
  // 이 기기에 남기지 못했는지(저장소가 가득 찼거나 막힘). 입력마다 알리지 않고 창 아래 안내 한 줄로만 둔다.
  const [draftUnstored, setDraftUnstored] = useState(false);
  useEffect(() => {
    if (props.mode !== "result" || !app.groupId || !hasInput) return;
    // 남은 내용을 고르지 않고 새로 입력하기 시작하면 새 입력을 남긴다(창에 보이는 쪽이 사용자가 원하는 내용이다).
    setLeftover(null);
    const stored = saveResultDraft(app.groupId, match.id, {
      matchVersion: match.version,
      winner,
      side,
      memo,
      champions,
      savedAt: Date.now(),
    });
    setDraftUnstored(!stored);
  }, [props.mode, app.groupId, match.id, match.version, hasInput, winner, side, memo, champions]);

  /**
   * 남은 내용으로 창을 채운다. 진영은 남은 값 그대로 쓴다(시작 때 진영이 바뀌었으면 요약의 "진영이 반대예요" 안내가 뜬다).
   * 챔피언 칸이 비어 있지 않으면 접힌 영역을 펼쳐 둔다. 펼치지 않으면 저장 때 챔피언을 보내는데 화면에는 안 보인다.
   */
  function resume({ draft }: LoadedResultDraft) {
    // 그 사이 명단이 바뀌었을 수 있으니 지금 명단에 있는 사람의 챔피언만 되살린다.
    const inRoster = new Set(match.roster.map((r) => r.participantId));
    const kept = Object.fromEntries(Object.entries(draft.champions).filter(([id]) => inRoster.has(id)));
    setWinner(draft.winner);
    // 3단계 화면에서 진영을 고르기 전에 닫았으면 진영이 비어 있다. 진영이 정해진 경기는 시작 진영으로 다시 채운다.
    setSide(draft.side ?? (draft.winner ? presetWinnerSide(draft.winner, match.teamASide) : null));
    setMemo(draft.memo);
    setChampions(kept);
    setChampionsOpen(Object.keys(kept).length > 0);
    setLeftover(null);
  }

  /** 남은 내용을 이 기기에서 지우고 빈 창으로 시작한다. */
  function discard() {
    if (app.groupId) clearResultDraft(app.groupId, match.id);
    setLeftover(null);
  }

  // 요청 ID는 창을 열 때 한 번 만들고, 내용이 바뀌면 새로 만든다. 재시도에는 같은 값을 쓴다.
  const request = useRef<{ id: string; key: string } | null>(null);

  async function save() {
    if (!winner || !side || !app.groupId || memoTooLong(memo)) return;
    const key = `${winner}:${side}:${memoChanged ? (memoValue ?? "") : "-"}:${JSON.stringify(champions)}`;
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
              ...(championCount > 0 ? { champions } : {}),
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
      if (props.mode === "result") clearResultDraft(app.groupId, match.id);
      await app.refreshAfterOwnChange();
      props.onSaved?.(result.match);
    } catch (e) {
      setError(e);
      // 그 사이 다른 기기·운영자가 저장했다. 최신 기록을 읽어 아래 conflictNote가 지금 승패를 보여 주게 한다.
      if (e instanceof ApiFailure && e.code === "VERSION_CONFLICT") void app.refresh();
    } finally {
      setBusy(false);
    }
  }

  // 다시 읽은 기록에서 이 경기가 이미 확정돼 있으면 일반 충돌 문구 대신 지금 승패를 적는다.
  // 누가 저장했는지는 모른다(이 기기의 앞선 요청일 수도 있다). 그래서 "다른 운영자가"라고 단정하지 않는다.
  const latest = app.snapshot?.matches.find((m) => m.id === match.id);
  const conflictNote =
    error instanceof ApiFailure &&
    error.code === "VERSION_CONFLICT" &&
    latest?.state === "confirmed" &&
    latest.winnerTeam &&
    latest.version !== match.version ? (
      <p className="note error" role="alert">
        {latest.matchNo}경기는 지금 {winnerText(latest.winnerTeam, latest.teamASide)} 기록이에요. 그 사이 다른 곳에서
        저장됐어요. 입력은 그대로 있어요. 다르면 창을 닫고 기록에서 승리 팀을 고쳐 주세요.
      </p>
    ) : null;
  const errorNote = conflictNote ?? <ErrorNote error={error} onCheck={() => void save()} resends="다시 저장해 보기" />;

  // 이어 쓰기 안내. 두 화면(큰 버튼 화면·3단계 화면) 맨 위에 같은 것을 둔다.
  // 경기 버전이 다르면(그 사이 명단 교체·진영 정정 등) 되살리기는 허락하되 다시 확인하라고 적는다.
  // 결과가 이미 확정된 경기는 이 창(결과 입력)이 열리지 않으므로 확정 결과를 옛 입력으로 덮을 일은 없다(서버도 baseMatchVersion으로 막는다).
  const leftoverNote = leftover && (
    <div className="note draft-note" role="status">
      <p>
        {formatTime(new Date(leftover.draft.savedAt).toISOString())}에 작성하던 내용이 이 기기에 남아 있어요.
        {leftover.draft.matchVersion !== match.version &&
          " 그 사이 이 경기가 다른 곳에서 바뀌었어요. 이어 쓴 뒤 명단과 진영을 다시 확인해 주세요."}
        {leftover.winnerReset && " 이긴 팀 기록은 읽을 수 없어 다시 골라야 해요. 메모와 챔피언은 이어 쓸 수 있어요."}
      </p>
      <div className="draft-note-actions">
        <button type="button" className="secondary" onClick={() => resume(leftover)}>
          작성하던 내용 이어 쓰기
        </button>
        <button type="button" className="link" onClick={discard}>
          버리고 새로 입력
        </button>
      </div>
    </div>
  );

  // 결과 저장(서버 확정)과 기기 임시 보관은 다른 일이라 문구에서 "결과 저장 전"을 분명히 한다.
  const unstoredNote = draftUnstored && (
    <p className="hint" role="status">
      이 기기에 작성 중인 내용을 남기지 못했어요. 결과 저장 전에 창을 닫으면 입력이 사라져요.
    </p>
  );

  const title = `${match.matchNo}경기 ${props.mode === "result" ? "결과" : "승리 팀 수정"}`;

  // 펼치기 전에는 고르기 칸(과 챔피언 목록 조각)을 그리지 않는다.
  const championSection = (
    <details
      className="champ-details"
      open={championsOpen}
      onToggle={(e) => setChampionsOpen(e.currentTarget.open)}
    >
      <summary>
        챔피언도 기록하기(선택)
        {championCount > 0 ? ` · ${championCount}명` : ""}
      </summary>
      {championsOpen && (
        <Suspense fallback={<p className="hint">불러오는 중…</p>}>
          <ChampionFields
            match={match}
            nameOf={nameOf}
            history={app.snapshot?.matches ?? []}
            value={champions}
            onChange={setChampions}
          />
        </Suspense>
      )}
    </details>
  );

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
        {/* 시험 운영 기간 피드백 입구. 메뉴 끝·상단 바 구석에만 있어 한 건도 오지 않아서, 방금 써 본 순간인 결과 저장 뒤에 둔다.
            다음 행동(주 버튼)보다 앞서지 않게 맨 아래 보조 글자 한 줄. 정정(mode "correct")에서는 띄우지 않는다. */}
        {props.mode === "result" && (
          <p className="hint result-feedback">
            써 보니 불편한 점이 있었나요?
            <button
              type="button"
              className="link"
              onClick={() => {
                props.onClose();
                go("/feedback");
              }}
            >
              피드백 보내기
            </button>
          </p>
        )}
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
        {leftoverNote}
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
            {side === "unknown" && <p className="hint">개인 승패는 기록되고 진영 통계에서만 빠져요.</p>}
          </section>
        )}

        {winner && (
          <details className="result-side">
            <summary>진영이 시작할 때와 달랐나요?</summary>
            <fieldset>
              <legend>이긴 팀({teamName(winner, match.teamASide)})은 실제로 어느 진영이었나요?</legend>
              <p className="hint">시작할 때 정한 진영으로 미리 골라 뒀어요. 실제와 다르면 바꿔 주세요.</p>
              <SideChoices side={side} onChange={setSide} />
            </fieldset>
          </details>
        )}

        {winner && <MemoField value={memo} onChange={setMemo} />}
        {winner && championSection}

        {unstoredNote}
        {errorNote}
        {/* 꺼진 저장 버튼만 보이면 무엇을 해야 하는지 알 수 없다. */}
        {!winner && <p className="hint">이긴 팀을 누르면 저장할 수 있어요.</p>}
        <button
          type="button"
          className="primary wide"
          disabled={!winner || !side || busy || memoTooLong(memo)}
          onClick={() => void save()}
        >
          {busy ? "저장 중" : "결과 저장"}
        </button>
      </Dialog>
    );
  }

  return (
    <Dialog title={title} onClose={props.onClose}>
      {leftoverNote}
      {props.mode === "correct" && (
        <p className="note">
          승리 팀을 바꾸면 10명의 승패가 서로 바뀌어요. 진영을 다시 확인해 주세요.
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
          <SideChoices side={side} onChange={setSide} />
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
            <p className="hint">개인 승패는 기록되고 진영 통계에서만 빠져요.</p>
          )}
          {props.mode === "result" && <MemoField value={memo} onChange={setMemo} />}
          {props.mode === "result" && championSection}
        </section>
      )}

      {unstoredNote}
      {errorNote}
      {!winner && <p className="hint">이긴 팀을 누르면 저장할 수 있어요.</p>}
      <button
        type="button"
        className="primary wide"
        disabled={!winner || !side || busy || memoTooLong(memo)}
        onClick={() => void save()}
      >
        {busy ? "저장 중" : "결과 저장"}
      </button>
    </Dialog>
  );
}
