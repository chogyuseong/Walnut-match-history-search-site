// 모임 탭 '경기 운영 설정'의 세 구역: 서포터 횟수 세기·초기화, 팀 추천의 최근 조합 피하기, 티어 공개.
// 세 구역 모두 모임 설정(Settings) 한 덩어리를 저장한다(kit.saveSettings). 구역마다 오류 자리가 다르다.
import { useState } from "react";
import { mutate, newRequestId } from "../../api";
import { rotationContext, supportCounts } from "../../../shared/rotation";
import { Help } from "../../screenKit";
import { SupportCountEditor } from "../../supportCountEditor";
import { Dialog, ErrorNote } from "../../ui";
import type { GroupKit } from "./kit";

/** 티어 공개 확인 창에서 "이렇게 보여요"로 미리 보여주는 사람 수. */
const PUBLIC_PREVIEW = 5;

export function RotationSection({ kit }: { kit: GroupKit }) {
  const { app, snapshot, gid, settings, busy } = kit;
  const [resetAsk, setResetAsk] = useState(false);
  const rotationEvents = snapshot.rotation?.events.length ?? 0;
  return (
    <section aria-label="서포터 횟수">
      <h2>서포터 횟수</h2>
      <label className="toggle">
        <input
          type="checkbox"
          checked={settings.rotationEnabled}
          disabled={busy}
          onChange={(e) =>
            void kit.saveSettings(
              { ...settings, rotationEnabled: e.target.checked },
              e.target.checked
                ? "서포터 횟수를 다시 세어요. 이전 기록을 이어가요."
                : "서포터 횟수 세기를 껐어요. 기록은 지우지 않았어요.",
              "rotation",
            )
          }
        />{" "}
        서포터로 간 횟수를 세고, 같은 팀에서 아직 서포터를 안 간 사람을 서포터로 골라요
      </label>
      {settings.rotationEnabled && (snapshot.session || snapshot.rotation) && (
        <p>
          <span className="hint">지금까지 서포터로 간 기록 {rotationEvents}건. </span>
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => {
              kit.clearError();
              setResetAsk(true);
            }}
          >
            서포터 횟수 초기화
          </button>
        </p>
      )}
      {kit.placeError("rotation")}
      {settings.rotationEnabled && (
        <details>
          <summary>서포터 횟수 보기·고치기</summary>
          <SupportCountEditor
            groupId={gid}
            people={snapshot.participants
              .filter((p) => p.status === "active" && !p.mergedInto)
              .sort((a, b) => a.name.localeCompare(b.name, "ko"))}
            counts={supportCounts(rotationContext(true, snapshot.rotation))}
            refresh={app.refreshAfterOwnChange}
            onSaved={() => app.setNotice("서포터 횟수를 저장했어요.")}
            label="전체 참가자 서포터 횟수"
            saveIsPrimary
          />
        </details>
      )}

      {resetAsk && (
        <Dialog title="서포터 횟수 초기화" onClose={() => setResetAsk(false)}>
          {/* 새 주기를 열면 지금까지 센 횟수로 되돌아갈 수 없다(되돌리기 API가 없다). 한 번 눌러 바로 바뀌지 않게 묻는다.
              문구는 준비 화면의 같은 확인 창(prep/SupportCountSection.tsx)과 맞춘다. */}
          <p>
            모든 사람의 서포터 횟수를 0으로 되돌리고, 초기화한 뒤에 시작하는 경기부터 다시 세어요. 그 전 경기의 기록과
            전적은 그대로예요. 되돌릴 수 없어요.
          </p>
          <ErrorNote error={kit.error} />
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                void kit
                  .run(
                    () =>
                      mutate(`/api/groups/${gid}/rotation/new-cycle`, {
                        requestId: newRequestId(),
                        baseLiveVersion: snapshot.group.liveVersion,
                      } as { requestId: string }),
                    "서포터 횟수를 초기화했어요. 전적은 그대로예요.",
                  )
                  .then((ok) => ok && setResetAsk(false))
              }
            >
              {busy ? "저장 중" : "초기화"}
            </button>
            <button type="button" className="secondary" onClick={() => setResetAsk(false)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

export function TeamDiversitySection({ kit }: { kit: GroupKit }) {
  const { settings } = kit;
  return (
    <section aria-label="팀 추천">
      <h2>팀 추천</h2>
      <label className="toggle">
        <input
          type="checkbox"
          checked={settings.teamDiversity !== false}
          disabled={kit.busy}
          onChange={(e) =>
            void kit.saveSettings(
              { ...settings, teamDiversity: e.target.checked },
              e.target.checked ? "팀 추천에서 최근 조합을 피하도록 했어요." : "팀 추천이 최근 조합을 따지지 않도록 했어요.",
              "team",
            )
          }
        />{" "}
        티어 균형이 같은 후보 중에서 최근 8경기에 같은 팀이었던 사람끼리 덜 묶이는 조합을 먼저 추천해요
      </label>
      <p className="hint">균형(티어 합계·인원)과 같은 팀·다른 팀 조건이 항상 먼저예요.</p>
      {kit.placeError("team")}
    </section>
  );
}

export function TierPublicSection({ kit }: { kit: GroupKit }) {
  const { snapshot, settings, busy } = kit;
  const [previewPublic, setPreviewPublic] = useState(false);
  return (
    <section aria-label="티어 공개">
      <h2>티어 공개</h2>
      <Help>
        티어는 팀 추천·팀·라인 모두 섞기에 쓰는 운영 기준이며 공식 등급이 아니에요. 공개 여부는 추천·섞기 결과를
        바꾸지 않아요.
      </Help>
      <p>
        지금: <strong>{settings.groupsPublic ? "조회자에게 공개" : "운영자만 봄"}</strong>{" "}
        <button
          type="button"
          className="link"
          onClick={() => {
            kit.clearError();
            setPreviewPublic(true);
          }}
        >
          {settings.groupsPublic ? "비공개로 바꾸기" : "공개로 바꾸기"}
        </button>
      </p>

      {previewPublic && (
        <Dialog title="티어 공개 설정" onClose={() => setPreviewPublic(false)}>
          {settings.groupsPublic ? (
            <p>
              비공개로 바꾸면 조회자에게 티어가 보이지 않아요. 이미 본 사람에게는 소용이
              없어요.
            </p>
          ) : (
            <>
              <p>공개로 바꾸면 모임 링크를 가진 모든 사람에게 이렇게 보여요.</p>
              <ul className="list">
                {snapshot.participants
                  .filter((p) => p.status === "active")
                  .slice(0, PUBLIC_PREVIEW)
                  .map((p) => (
                    <li key={p.id} className="list-row static">
                      <span>{p.name}</span>
                      <span>{p.skillGroup ? `${p.skillGroup}티어` : "미지정"}</span>
                    </li>
                  ))}
              </ul>
              <p className="hint">한번 공개된 평가는 되돌릴 수 없어요.</p>
            </>
          )}
          {/* 실패하면 대화 상자를 열어 둔 채 이유를 보여 준다. */}
          <ErrorNote error={kit.error} />
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void kit
                  .saveSettings(
                    { ...settings, groupsPublic: !settings.groupsPublic },
                    settings.groupsPublic ? "비공개로 바꿨어요." : "공개로 바꿨어요.",
                  )
                  .then((ok) => ok && setPreviewPublic(false))
              }
            >
              {settings.groupsPublic ? "비공개로 바꾸기" : "공개로 바꾸기"}
            </button>
            <button type="button" className="secondary" onClick={() => setPreviewPublic(false)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
