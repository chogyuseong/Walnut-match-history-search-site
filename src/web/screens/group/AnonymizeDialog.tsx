import { useState } from "react";
import type { ParticipantView } from "../../../shared/types";
import { mutate, newRequestId } from "../../api";
import { Dialog, ErrorNote } from "../../ui";
import type { GroupKit } from "./kit";

type AnonymizeResult = { name: string; count: number; memoMatchNos: number[] };

/**
 * 참가자 익명 처리(migrations/0019) 확인 창과 끝난 뒤 안내 창. 참가자 '수정' 창과 '참가자 요청'의 삭제 요청
 * 두 곳에서 연다. person이 null이면 확인 창은 닫혀 있다.
 * 안내 창은 person이 null로 바뀐 뒤에도 떠 있어야 해서 결과를 이 컴포넌트가 들고 있다. 그러니 부모는
 * 이 컴포넌트를 person과 상관없이 늘 그려 둔다(조건부로 그리면 안내 창이 바로 사라진다).
 */
export function AnonymizeDialog(props: { kit: GroupKit; person: ParticipantView | null; onClose: () => void; onDone: () => void }) {
  const { kit, person } = props;
  const [confirmText, setConfirmText] = useState("");
  const [result, setResult] = useState<AnonymizeResult | null>(null);
  const close = () => {
    setConfirmText("");
    props.onClose();
  };

  return (
    <>
      {person && (
        <Dialog title={`${person.name} 익명 처리`} onClose={close}>
          <p>
            <strong>{person.name}</strong>의 이름을 '탈퇴한 참가자 N'으로 바꾸고 보관해요. 계정 연결·기피 라인·티어·이 사람의 요청과
            참가 신청을 지워요. 이 사람에게 합쳐진 이름도 함께 바꿔요.
          </p>
          <p>
            경기 기록(승패·라인)은 다른 사람의 전적이 깨지지 않게 이름 없이 남아요. <strong>되돌릴 수 없어요.</strong> 예전에
            내려받은 백업 파일과 서버 자동 백업(최대 30일)에는 옛 이름이 남아 있고, 그 백업으로 복원하면 옛 이름이 돌아와요.
          </p>
          <label>
            확인 문구 '익명'을 입력해 주세요
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} aria-label="익명 처리 확인 문구" />
          </label>
          <ErrorNote error={kit.error} />
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={kit.busy || confirmText.trim() !== "익명"}
              onClick={() => {
                void kit
                  .run(async () => {
                    const done = await mutate<AnonymizeResult>(`/api/groups/${kit.gid}/participants/${person.id}/anonymize`, {
                      requestId: newRequestId(),
                      confirm: "익명",
                    });
                    setResult(done);
                  })
                  .then((ok) => {
                    if (!ok) return;
                    setConfirmText("");
                    props.onDone();
                  });
              }}
            >
              익명으로 바꾸기
            </button>
            <button type="button" className="secondary" onClick={close}>
              그만두기
            </button>
          </div>
        </Dialog>
      )}

      {result && (
        <Dialog title="익명 처리 완료" onClose={() => setResult(null)}>
          <p>
            '{result.name}'(으)로 바꿨어요{result.count > 1 ? ` (합쳐진 이름 포함 ${result.count}명)` : ""}.
          </p>
          {result.memoMatchNos.length > 0 ? (
            <p className="note warn">
              경기 메모에 옛 이름이 남아 있어요: {result.memoMatchNos.map((n) => `${n}경기`).join(", ")}. 메모는 자동으로 고치지
              않아요. 경기 상세에서 직접 고쳐 주세요.
            </p>
          ) : (
            <p className="hint">경기 메모에 옛 이름이 들어 있는 곳은 없어요.</p>
          )}
          <p className="hint">이 사람이 남긴 요청도 함께 지워졌어요.</p>
          <button type="button" className="primary" onClick={() => setResult(null)}>
            확인
          </button>
        </Dialog>
      )}
    </>
  );
}
