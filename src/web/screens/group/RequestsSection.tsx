// 모임 탭 '자주 쓰는 것'의 참가자 요청: 본인과 연결한 참가자가 남긴 정정·삭제 요청을 처리함·반려로 표시한다.
import { useState } from "react";
import type { MemberRequestView, ParticipantView } from "../../../shared/types";
import { memoLength } from "../../../shared/memo";
import { mutate, newRequestId } from "../../api";
import { nameMap } from "../../format";
import { Dialog, ErrorNote } from "../../ui";
import { go } from "../../useApp";
import { RequestRow } from "../Member";
import { AnonymizeDialog } from "./AnonymizeDialog";
import type { GroupKit } from "./kit";

/** 운영자 답 글자 수 한도. 서버 REQUEST_TEXT_MAX(src/server/members.ts)와 같아야 한다. 넘으면 서버가 거절한다. */
const REPLY_MAX = 200;

export function RequestsSection({ kit }: { kit: GroupKit }) {
  const { snapshot, gid, busy } = kit;
  const [resolving, setResolving] = useState<{ request: MemberRequestView; status: "done" | "declined" } | null>(null);
  const [reply, setReply] = useState("");
  const [anonFor, setAnonFor] = useState<ParticipantView | null>(null);

  const nameOf = nameMap(snapshot);
  const tz = snapshot.group.timezone;
  const requests = snapshot.memberRequests ?? [];
  const openRequests = requests.filter((r) => r.status === "open");
  const resolvedRequests = requests.filter((r) => r.status !== "open");
  const matchNoOf = (id: string | null) => snapshot.matches.find((m) => m.id === id)?.matchNo;
  const replyLength = memoLength(reply.trim());

  return (
    <section aria-label="참가자 요청">
      <h2>
        참가자 요청{" "}
        {openRequests.length > 0 && (
          <span className="badge">
            <span aria-hidden="true">{openRequests.length}</span>
            <span className="sr-only">처리할 요청 {openRequests.length}개</span>
          </span>
        )}
      </h2>
      <p className="hint">
        본인과 연결한 참가자가 남긴 정정·삭제 요청이에요. 기록은 바뀌지 않았어요. 직접 고친 뒤 '처리함'으로, 받아들이지 않으면
        '반려'로 표시하면 요청한 사람이 상태와 답을 봐요.
      </p>
      {openRequests.length === 0 ? (
        <p className="hint">처리할 요청이 없어요.</p>
      ) : (
        <ul className="list" aria-label="처리할 요청">
          {openRequests.map((r) => (
            <RequestRow key={r.id} request={r} matchNo={matchNoOf(r.matchId)} tz={tz} who={nameOf(r.participantId)}>
              <span className="button-row">
                {r.matchId && matchNoOf(r.matchId) !== undefined && (
                  <button type="button" className="link" onClick={() => go(`/m/${r.matchId}`)}>
                    {matchNoOf(r.matchId)}경기 보기
                  </button>
                )}
                {r.kind === "erase" && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      const person = snapshot.participants.find((x) => x.id === r.participantId);
                      if (person) setAnonFor(person);
                    }}
                  >
                    익명 처리…
                  </button>
                )}
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setReply("");
                    setResolving({ request: r, status: "done" });
                  }}
                >
                  처리함
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  onClick={() => {
                    setReply("");
                    setResolving({ request: r, status: "declined" });
                  }}
                >
                  반려
                </button>
              </span>
            </RequestRow>
          ))}
        </ul>
      )}
      {resolvedRequests.length > 0 && (
        <details>
          <summary>처리한 요청 {resolvedRequests.length}개</summary>
          <ul className="list" aria-label="처리한 요청">
            {resolvedRequests.map((r) => (
              <RequestRow key={r.id} request={r} matchNo={matchNoOf(r.matchId)} tz={tz} who={nameOf(r.participantId)} />
            ))}
          </ul>
        </details>
      )}

      {resolving && (
        <Dialog title={resolving.status === "done" ? "처리함으로 표시" : "반려"} onClose={() => setResolving(null)}>
          <p>
            {nameOf(resolving.request.participantId)}의 요청을 '{resolving.status === "done" ? "처리함" : "반려"}'으로 표시해요. 요청한
            사람이 상태와 답을 봐요.
          </p>
          <label>
            짧은 답 (선택)
            <textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)} aria-label="운영자 답" />
          </label>
          <p className={replyLength > REPLY_MAX ? "hint warn" : "hint"}>
            {replyLength} / {REPLY_MAX}자
          </p>
          <ErrorNote error={kit.error} />
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy || replyLength > REPLY_MAX}
              onClick={() => {
                const target = resolving;
                void kit
                  .run(
                    () =>
                      mutate(`/api/groups/${gid}/member-requests/${target.request.id}/resolve`, {
                        requestId: newRequestId(),
                        status: target.status,
                        ...(reply.trim() !== "" ? { reply } : {}),
                      }),
                    target.status === "done" ? "처리함으로 표시했어요." : "반려했어요.",
                  )
                  .then((ok) => ok && setResolving(null));
              }}
            >
              {resolving.status === "done" ? "처리함으로 표시" : "반려하기"}
            </button>
            <button type="button" className="secondary" onClick={() => setResolving(null)}>
              그만두기
            </button>
          </div>
        </Dialog>
      )}

      <AnonymizeDialog kit={kit} person={anonFor} onClose={() => setAnonFor(null)} onDone={() => setAnonFor(null)} />
    </section>
  );
}
