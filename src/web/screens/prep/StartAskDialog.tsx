import type { Draft } from "../../../shared/draft";
import { rotationContext, supportCounts } from "../../../shared/rotation";
import { Dialog, ErrorNote } from "../../ui";
import { go } from "../../useApp";
import type { PrepStart, StartAsk } from "./usePrepStart";

/** 시작 확인 창: 진행 중인 경기·서포터 반복·같은 팀 구성·12시간 공백(새 내전 여부)을 한 창에 모아 묻는다. */
export function StartAskDialog(props: {
  draft: Draft;
  ask: StartAsk;
  start: PrepStart;
  busy: boolean;
  error: unknown;
}) {
  const { draft, ask, start, busy } = props;
  const { newSession, setNewSession, setAsk } = start;
  return (
    <Dialog title="시작 전에 확인해 주세요" onClose={() => setAsk(null)}>
      {ask.inProgress && (
        <p>
          {ask.inProgress.matchNo}경기가 아직 진행 중이에요. 시작하면 그 경기는 "결과
          미입력"으로 넘어가고 결과는 나중에 넣을 수 있어요.{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              setAsk(null);
              go("/match");
            }}
          >
            먼저 결과 입력하기
          </button>
        </p>
      )}
      {ask.repeatIds.map((id) => {
        const latest = rotationContext(ask.snapshot.group.settings.rotationEnabled, ask.snapshot.rotation);
        return (
          <p key={id}>
            <strong>{draft.people.find((p) => p.participantId === id)?.name ?? ""}</strong>님은 이미{" "}
            {supportCounts(latest).get(id) ?? 0}번 갔고 같은 팀에 더 적게 간 사람이 있어요. 그대로 시작할까요?
          </p>
        );
      })}
      {ask.sameTeams && (
        <p>
          직전 경기와 같은 팀 구성이에요. 그대로 시작할까요?{" "}
          <span className="hint">({ask.sameTeams.matchNo}경기와 같은 사람들끼리예요. 진영만 바뀐 것도 같은 구성으로 봐요.)</span>
        </p>
      )}
      {ask.askSession && (
        <fieldset>
          <legend>마지막 경기 뒤로 12시간이 넘었어요.</legend>
          <label>
            <input
              type="radio"
              name="session"
              checked={newSession}
              onChange={() => setNewSession(true)}
            />{" "}
            새 내전으로 시작 (서포터 횟수도 새로 시작)
          </label>
          <label>
            <input
              type="radio"
              name="session"
              checked={!newSession}
              onChange={() => setNewSession(false)}
            />{" "}
            지난 내전에 이어서
          </label>
        </fieldset>
      )}
      <ErrorNote error={props.error} onCheck={start.retryLast} />
      <div className="button-row">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => void start.sendStart(draft, ask, newSession)}
        >
          {busy
            ? "저장 중"
            : ask.inProgress
              ? "결과는 나중에 입력하고 시작"
              : "이대로 시작"}
        </button>
        <button type="button" className="secondary" onClick={() => setAsk(null)}>
          편성으로 돌아가기
        </button>
      </div>
    </Dialog>
  );
}
