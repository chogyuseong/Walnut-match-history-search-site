import { useState } from "react";
import type { Draft } from "../../../shared/draft";
import { resetCountsReady, supportCounts, type RotationContext } from "../../../shared/rotation";
import { mutate, newRequestId } from "../../api";
import { SupportCountEditor } from "../../supportCountEditor";
import { formatTime } from "../../format";
import { Dialog, ErrorNote, Help } from "../../ui";
import type { AppValue } from "../../useApp";
import type { PrepStatus } from "./usePrepStart";

/** "섞기 기준" 줄의 서포터 횟수 버튼 글자: 이번 주기에 서포터로 간 사람 수. */
export function supportCountLabel(app: AppValue, ctx: RotationContext): string {
  const n = [...supportCounts(ctx).values()].filter((count) => count > 0).length;
  return n === 0 ? "서포터 횟수: 아직 없음" : `서포터 횟수: ${n}명 기록`;
}

/**
 * 서포터 횟수 판과 초기화 확인 창. 섞기 구역의 "서포터 횟수" 버튼(ShuffleSection, 티어 배정·기피 라인 옆)을 누르면
 * 그 바로 아래에 펼쳐진다(2026-11-08, 예전에는 아래쪽 접힘 구역). 서포터 돌아가며가 꺼져 있으면 그리지 않는다.
 * 저장 중 표시·오류는 시작 흐름과 같은 것을 쓴다(PrepStatus).
 */
export function SupportCountSection(props: {
  app: AppValue;
  draft: Draft;
  ctx: RotationContext;
  status: PrepStatus;
  /** 횟수가 바뀌었을 때 서포터만 바꾸기 결과 안내를 지운다. */
  clearDrawNote: () => void;
  /** 판을 펼쳐 보이는지(버튼은 ShuffleSection에 있다). */
  open: boolean;
}) {
  const { app, draft, ctx, status } = props;
  const { busy, error } = status;
  const [resetOpen, setResetOpen] = useState(false);

  // 서포터 횟수 목록: 이번 주기에 한 번이라도 간 사람(많이 간 순). 이름은 모임 참가자 이름.
  const participantName = new Map((app.snapshot?.participants ?? []).map((p) => [p.id, p.name]));
  const countRows = [...supportCounts(ctx).entries()]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ({ id, n, name: participantName.get(id) ?? "(이름 없음)" }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, "ko"));
  const canReset = ctx.enabled && !!app.me?.accountId && app.snapshot !== null;
  // 초기화는 지금 초안의 두 팀 중 하나라도 모두 서포터를 배정받았을 때만 켠다(초안에서 바로 계산).
  // 첫 경기 전(주기 없음)에 직접 넣은 횟수로도 켜진다. 서버는 그때 미리 넣어 둔 값만 지운다.
  const resetReady = resetCountsReady(draft, ctx);
  // 언제부터 세는지: 활성 주기가 열린 시각(새 내전 시작 또는 초기화)과 그 뒤에 센 경기 수.
  const rotation = app.snapshot?.rotation ?? null;
  const cycleStartedAt = rotation?.cycleStartedAt ?? null;
  const countedMatches = new Set((rotation?.events ?? []).map((e) => e.matchId)).size;
  const countPeople = draft.people
    .filter((p) => p.participantId !== null)
    .map((p) => ({ id: p.participantId!, name: p.name }));

  /** 서포터 횟수 초기화(새 주기). 모임 탭의 같은 버튼과 같은 동작이다. */
  async function resetCounts() {
    if (!app.snapshot) return;
    status.setBusy(true);
    status.setError(null);
    try {
      await mutate(`/api/groups/${app.snapshot.group.id}/rotation/new-cycle`, {
        requestId: newRequestId(),
        baseLiveVersion: app.snapshot.group.liveVersion,
      } as { requestId: string });
      await app.refreshAfterOwnChange();
      setResetOpen(false);
      props.clearDrawNote();
      app.setNotice("서포터 횟수를 초기화했어요. 전적은 그대로입니다.");
    } catch (e) {
      status.setError(e);
      void app.refresh();
    } finally {
      status.setBusy(false);
    }
  }

  return (
    <>
      {ctx.enabled && (
        // 닫혀 있어도 DOM에 두고 hidden으로 숨긴다(예전 접힘 구역과 같은 동작: 안의 버튼 상태를 테스트·검색이 볼 수 있다).
        <section id="support-count-panel" className="prep-tools support-panel" aria-label="서포터 횟수" hidden={!props.open}>
          <h2>서포터 횟수</h2>
          <Help>
            "이 팀으로 시작"으로 실제 시작한 경기만 셉니다. 섞기·서포터만 바꾸기는 횟수를 올리지 않아요. 새 내전을
            시작하거나 초기화하면 그 뒤에 시작한 경기부터 다시 셉니다. 그 전 경기는 기록만 남고 횟수에는 들어가지 않아요.
          </Help>
          {cycleStartedAt ? (
            <p className="hint" data-testid="count-since">
              지금은 {formatTime(cycleStartedAt, app.snapshot?.group.timezone)}부터 세고 있어요 (그 뒤에 시작한 경기{" "}
              {countedMatches}개).
            </p>
          ) : (
            <p className="hint" data-testid="count-since">
              아직 이번 내전의 첫 경기 전이에요. 첫 경기를 시작하면 그때부터 셉니다.
            </p>
          )}
          {countRows.length === 0 ? (
            <p className="hint">아직 서포터로 간 사람이 없어요.</p>
          ) : (
            <ul className="list" aria-label="서포터 횟수 목록">
              {countRows.map((row) => (
                <li key={row.id} className="list-row static">
                  <span className="name">{row.name}</span>
                  <span className="stat">서폿 {row.n}회</span>
                </li>
              ))}
            </ul>
          )}
          {canReset && app.snapshot ? (
            <>
              <h3>이번 편성 횟수 고치기</h3>
              <p className="hint">
                사이트 밖에서 이미 몇 판 했거나 횟수가 잘못 쌓였으면 여기서 바로 고쳐요. 첫 경기 전에도 넣을 수 있어요.
              </p>
              <SupportCountEditor
                groupId={app.snapshot.group.id}
                people={countPeople}
                counts={supportCounts(ctx)}
                refresh={app.refreshAfterOwnChange}
                onSaved={() => {
                  props.clearDrawNote();
                  app.setNotice("서포터 횟수를 저장했어요.");
                }}
                label="이번 편성 서포터 횟수"
              />
              {countPeople.length < draft.people.length && (
                <p className="hint">새로 넣은 이름은 첫 경기를 시작한 뒤에 고칠 수 있어요.</p>
              )}
            </>
          ) : (
            <p className="hint">로그인하면 서포터 횟수를 직접 고칠 수 있어요.</p>
          )}
          {canReset && (
            <div className="button-row">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                aria-describedby="reset-counts-why"
                onClick={() => setResetOpen(true)}
              >
                서포터 횟수 초기화
              </button>
              <span id="reset-counts-why" className="hint">
                {resetReady
                  ? "한 팀이 모두 서포터를 배정받았어요. 초기화하면 다시 처음부터 돌아가요."
                  : "아직 서포터를 안 간 사람이 있어요. 그래도 초기화할 수 있어요(누르면 한 번 더 물어봐요)."}
              </span>
            </div>
          )}
        </section>
      )}

      {resetOpen && (
        <Dialog title="서포터 횟수 초기화" onClose={() => setResetOpen(false)}>
          <p>
            모든 사람의 서포터 횟수를 0으로 되돌리고, 초기화한 뒤에 시작하는 경기부터 다시 셉니다. 그 전 경기의 기록과
            전적은 그대로예요.
          </p>
          {!resetReady && (
            <p className="note" role="alert">
              아직 서포터를 안 간 사람이 있어요. 지금 초기화하면 이미 간 사람이 다시 서포터로 뽑힐 수 있어요. 되돌릴 수
              없어요.
            </p>
          )}
          <ErrorNote error={error} />
          <div className="button-row">
            <button type="button" className="danger" disabled={busy} onClick={() => void resetCounts()}>
              초기화
            </button>
            <button type="button" className="secondary" onClick={() => setResetOpen(false)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
