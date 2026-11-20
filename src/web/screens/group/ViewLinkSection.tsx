import { useState } from "react";
import { mutate, newRequestId } from "../../api";
import { viewLink } from "../../format";
import { CopyButton, Dialog, ErrorNote } from "../../ui";
import type { GroupKit } from "./kit";

/** 모임 탭 '자주 쓰는 것'의 모임 링크(조회 전용) 복사와 다시 만들기. id="group-view-link"는 다른 화면에서 이리로 건너오는 표식이다. */
export function ViewLinkSection({ kit }: { kit: GroupKit }) {
  const [confirmToken, setConfirmToken] = useState(false);
  return (
    <section aria-label="모임 링크" id="group-view-link">
      <h2>모임 링크</h2>
      <p className="hint">
        단톡방에 한 번 올려 두면 돼요. 경기 중에는 지금 편성과 내 자리를, 그 밖에는 기록과 내 전적을 보여 줘요. 로그인
        없이 보고, 수정은 할 수 없어요.
      </p>
      <div className="button-row">
        <CopyButton label="모임 링크 복사" text={() => viewLink(kit.snapshot.group.viewToken!)} />
        <button
          type="button"
          className="link"
          onClick={() => {
            kit.clearError();
            setConfirmToken(true);
          }}
        >
          링크 다시 만들기
        </button>
      </div>

      {confirmToken && (
        <Dialog title="링크 다시 만들기" onClose={() => setConfirmToken(false)}>
          <p>
            새 링크를 만들면 지금까지 공유한 링크는 더 이상 열리지 않아요. 참가자에게 새 링크를 다시
            보내야 해요.
          </p>
          {/* 실패하면 대화 상자를 열어 둔 채 이유를 보여 준다. */}
          <ErrorNote error={kit.error} />
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={kit.busy}
              onClick={() =>
                void kit
                  .run(() => mutate(`/api/groups/${kit.gid}/view-token`, { requestId: newRequestId() }), "새 링크를 만들었어요.")
                  .then((ok) => ok && setConfirmToken(false))
              }
            >
              새 링크 만들기
            </button>
            <button type="button" className="secondary" onClick={() => setConfirmToken(false)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
