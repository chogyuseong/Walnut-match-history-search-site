// 모임 탭 '기록 관리'의 구역들: 지난 경기 넣기로 가는 길, 날짜 점검과 가져온 묶음의 전적 제외·복구, 시즌.
// MMR·칭호 설정은 RatingSettings.tsx·../TitleSettings.tsx에 따로 있다.
import { useRef, useState } from "react";
import { ApiFailure, mutate, newRequestId } from "../../api";
import { formatDate, formatRange, formatTime } from "../../format";
import { Help } from "../../screenKit";
import { go } from "../../useApp";
import type { GroupKit } from "./kit";

/** 지난 경기 한 건·표·구글 시트·기존 사이트에서 기록을 넣는 화면으로 가는 버튼들. 두 구역을 이어서 돌려준다. */
export function RecordEntrySections() {
  return (
    <>
      <section aria-label="지난 경기 입력">
        <h2>지난 경기 입력</h2>
        <p className="hint">
          이미 끝난 경기 하나를 결과까지 넣어요. 오늘 내전과 서포터 횟수에는 영향이 없어요.
        </p>
        <button type="button" className="secondary" onClick={() => go("/backfill")}>
          지난 경기 한 건 넣기
        </button>
      </section>
      <section aria-label="표 일괄 입력">
        <h2>표 일괄 입력</h2>
        <p className="hint">
          시트에 적어 둔 지난 경기를 붙여 넣어 한꺼번에 넣어요. 현재 경기와 서포터 횟수에는 영향이
          없어요.
        </p>
        <div className="button-row">
          <button type="button" className="secondary" onClick={() => go("/import")}>
            지난 기록 한꺼번에 넣기
          </button>
          <button type="button" className="secondary" onClick={() => go("/sheet-import")}>
            구글 시트에서 가져오기
          </button>
          <button type="button" className="secondary" onClick={() => go("/legacy-import")}>
            기존 사이트 기록 가져오기
          </button>
        </div>
        <p className="hint">
          기존 사이트(구글 시트 + 연결 주소)를 쓰던 모임은 그때 쓰던 연결 주소(script.google.com/macros/s/…/exec)로
          기록을 그대로 옮길 수 있어요. 구글 시트 주소와는 다른 주소예요.
        </p>
      </section>
    </>
  );
}

/**
 * 날짜 점검으로 가는 버튼과, 한 번에 가져온 묶음마다 '모두 전적 제외'·'모두 복구'.
 * 복구하려는 경기가 이미 기록에 있는 경기와 겹치면 서버가 RESTORE_DUPLICATE로 거절한다. 그때 겹치지 않는
 * 경기만 복구할지 그 묶음 바로 아래에서 묻는다.
 */
export function ImportBatchesSection({ kit }: { kit: GroupKit }) {
  const { snapshot, gid, busy } = kit;
  const [restoreOverlap, setRestoreOverlap] = useState<{ batchId: string; overlapping: number; restorable: number } | null>(
    null,
  );
  const batches = snapshot.importBatches ?? [];
  const tz = snapshot.group.timezone;
  return (
    <section aria-label="날짜 점검">
      <h2>날짜 점검</h2>
      <p className="hint">
        가져온 기록의 연도가 밀렸거나 같은 시각에 겹친 경기를 찾아요. 연도가 통째로 틀린 묶음은 한 번에 옮길 수 있어요.
      </p>
      <button type="button" className="secondary" onClick={() => go("/dates")}>
        날짜 점검
      </button>
      {batches.length > 0 && (
        <ul className="list">
          {batches.map((b) => {
            const allExcluded = b.excluded === b.count;
            return (
              <li key={b.id} className="list-row static">
                <span>
                  {formatDate(b.importedAt, tz)} {formatTime(b.importedAt, tz)} · {b.count}경기
                  {b.kind === "sheet" ? ` · 구글 시트${b.label ? `(${b.label})` : ""}` : b.kind === "legacy" ? " · 기존 사이트" : ""}
                  {b.excluded > 0 && (
                    <>
                      <br />
                      <span className="hint">전적 제외 {b.excluded}경기</span>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className={allExcluded ? "secondary" : "danger"}
                  disabled={busy}
                  onClick={() => {
                    setRestoreOverlap(null);
                    void kit.run(
                      async () => {
                        try {
                          await mutate(`/api/groups/${gid}/imports/${b.id}`, {
                            requestId: newRequestId(),
                            exclude: !allExcluded,
                          });
                        } catch (e) {
                          if (e instanceof ApiFailure && e.code === "RESTORE_DUPLICATE") {
                            setRestoreOverlap({
                              batchId: b.id,
                              overlapping: Array.isArray(e.details?.overlaps) ? e.details.overlaps.length : 0,
                              restorable: Number(e.details?.restorable ?? 0),
                            });
                          }
                          throw e;
                        }
                      },
                      allExcluded
                        ? `${b.count}경기를 복구했어요.`
                        : `이때 넣은 경기를 모두 전적 제외했어요. 같은 자리에서 복구할 수 있어요.`,
                      "imports",
                    );
                  }}
                >
                  {allExcluded ? "모두 복구" : "모두 전적 제외"}
                </button>
                {restoreOverlap?.batchId === b.id && (
                  <div className="note warn" role="status">
                    <p>
                      겹치는 {restoreOverlap.overlapping}경기는 그대로 두고{" "}
                      {restoreOverlap.restorable > 0
                        ? `나머지 ${restoreOverlap.restorable}경기만 복구할 수 있어요.`
                        : "복구할 경기가 남지 않아요."}
                    </p>
                    {restoreOverlap.restorable > 0 && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                          const count = restoreOverlap.restorable;
                          void kit
                            .run(
                              () =>
                                mutate(`/api/groups/${gid}/imports/${b.id}`, {
                                  requestId: newRequestId(),
                                  exclude: false,
                                  skipOverlapping: true,
                                }),
                              `겹치지 않는 ${count}경기를 복구했어요.`,
                              "imports",
                            )
                            .then((ok) => {
                              if (ok) setRestoreOverlap(null);
                            });
                        }}
                      >
                        겹치지 않는 {restoreOverlap.restorable}경기만 복구
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {kit.placeError("imports")}
    </section>
  );
}

const EMPTY_SEASON = { name: "", startsOn: "", endsOn: "" };

/** 시즌 목록·지우기·만들기. 시즌은 기록을 날짜로 나눠 보는 필터일 뿐이라 지워도 경기는 그대로다. */
export function SeasonsSection({ kit }: { kit: GroupKit }) {
  const { snapshot, gid, busy } = kit;
  const [seasonForm, setSeasonForm] = useState(EMPTY_SEASON);
  // 시즌 만들기 요청 ID: 같은 내용을 다시 보내면(응답을 못 받은 뒤 재시도) 같은 값을 쓴다. 성공하면 비운다.
  const seasonRequest = useRef<{ id: string; key: string } | null>(null);
  return (
    <section aria-label="시즌">
      <h2>시즌</h2>
      <Help>
        시즌은 기록을 날짜로 나눠 보는 필터예요. 배치와 누적 기록은 시즌으로 초기화되지
        않아요. 시즌끼리는 날짜가 겹칠 수 없어요.
      </Help>
      {snapshot.seasons.length > 0 && (
        <ul className="list list-card" aria-label="시즌 목록">
          {snapshot.seasons.map((s) => (
            <li key={s.id} className="list-row static">
              <span>
                {s.name}
                <br />
                <span className="hint">{formatRange(s.startsOn, s.endsOn, snapshot.group.timezone)}</span>
              </span>
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() =>
                  void kit.run(
                    () => mutate(`/api/groups/${gid}/seasons/${s.id}`, { requestId: newRequestId() }, "DELETE"),
                    `'${s.name}' 시즌을 지웠어요. 경기 기록은 그대로예요.`,
                    "seasons",
                  )
                }
              >
                지우기
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="season-form"
        onSubmit={(event) => {
          event.preventDefault();
          // 요청 ID는 같은 내용으로 다시 제출하면(실패·확인 불가 뒤) 같은 값을 쓴다. 내용이 바뀌거나 성공하면 새로
          // 만든다. 실패하면 입력을 남긴다.
          const key = JSON.stringify(seasonForm);
          if (seasonRequest.current?.key !== key) seasonRequest.current = { id: newRequestId(), key };
          const requestId = seasonRequest.current.id;
          void kit
            .run(() => mutate(`/api/groups/${gid}/seasons`, { requestId, ...seasonForm }), "시즌을 만들었어요.", "seasons")
            .then((ok) => {
              if (!ok) return;
              seasonRequest.current = null;
              setSeasonForm(EMPTY_SEASON);
            });
        }}
      >
        <label>
          시즌 이름
          <input
            value={seasonForm.name}
            maxLength={20}
            onChange={(e) => setSeasonForm({ ...seasonForm, name: e.target.value })}
          />
        </label>
        <div className="input-row">
          <label>
            시작일
            <input
              type="date"
              value={seasonForm.startsOn}
              onChange={(e) => setSeasonForm({ ...seasonForm, startsOn: e.target.value })}
            />
          </label>
          <label>
            종료일
            <input
              type="date"
              value={seasonForm.endsOn}
              onChange={(e) => setSeasonForm({ ...seasonForm, endsOn: e.target.value })}
            />
          </label>
        </div>
        <button
          type="submit"
          className="secondary"
          disabled={busy || seasonForm.name.trim() === "" || seasonForm.startsOn === "" || seasonForm.endsOn === ""}
        >
          시즌 만들기
        </button>
      </form>
      {kit.placeError("seasons")}
    </section>
  );
}
