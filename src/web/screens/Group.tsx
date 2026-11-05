import { useState } from "react";
import type { ParticipantView, Settings } from "../../shared/types";
import { call, mutate, newRequestId } from "../api";
import { formatDate, formatTime, viewLink } from "../format";
import { CopyButton, Dialog, ErrorNote } from "../ui";
import { go, useAppValue } from "../useApp";

/** 모임 탭. 첫 경기에 필요하지 않은 설정이 여기에 모여 있다. */
export function Group() {
  const app = useAppValue();
  const snapshot = app.snapshot;
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [previewPublic, setPreviewPublic] = useState(false);
  const [confirmToken, setConfirmToken] = useState(false);
  const [editing, setEditing] = useState<ParticipantView | null>(null);
  const [editName, setEditName] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [seasonForm, setSeasonForm] = useState({ name: "", startsOn: "", endsOn: "" });
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferLink, setTransferLink] = useState<string | null>(null);

  if (!snapshot) {
    return (
      <div className="screen">
        <h1>모임</h1>
        <p>아직 모임이 없어요. 첫 경기를 시작하면 만들어집니다.</p>
        <button type="button" className="primary" onClick={() => go("/")}>
          오늘로 가기
        </button>
      </div>
    );
  }
  const gid = snapshot.group.id;
  const settings = snapshot.group.settings;

  async function run(work: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await app.refreshAfterOwnChange();
      if (done) app.setNotice(done);
    } catch (e) {
      setError(e);
      void app.refresh();
    } finally {
      setBusy(false);
    }
  }

  const saveSettings = (next: Settings, done: string) =>
    run(
      () =>
        mutate(
          `/api/groups/${gid}/settings`,
          {
            requestId: newRequestId(),
            baseSettingsVersionId: snapshot.group.settingsVersionId,
            settings: next,
          } as { requestId: string },
          "PUT",
        ),
      done,
    );

  const patchParticipant = (id: string, body: Record<string, unknown>, done: string) =>
    run(() => call("PATCH", `/api/groups/${gid}/participants/${id}`, body), done);

  const people = snapshot.participants
    .filter((p) => (showArchived ? true : p.status === "active"))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const rotationEvents = snapshot.rotation?.events.length ?? 0;

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>모임</h1>
      </header>
      <ErrorNote error={error} />

      <section aria-label="모임 이름">
        <h2>모임 이름</h2>
        <form
          className="input-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (name === null || name.trim() === "") return;
            void run(() => call("PATCH", `/api/groups/${gid}`, { name }), "모임 이름을 바꿨어요.").then(
              () => setName(null),
            );
          }}
        >
          <input
            aria-label="모임 이름"
            value={name ?? snapshot.group.name}
            maxLength={20}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="secondary" disabled={busy || name === null}>
            저장
          </button>
        </form>
      </section>

      <section aria-label="조회 링크">
        <h2>조회 링크</h2>
        <p className="hint">
          이 링크를 받은 사람은 로그인 없이 명단과 기록을 볼 수 있습니다. 수정은 할 수 없습니다.
        </p>
        <div className="button-row">
          <CopyButton label="현재 경기 링크 복사" text={() => viewLink(snapshot.group.viewToken!)} />
          <button type="button" className="link" onClick={() => setConfirmToken(true)}>
            링크 다시 만들기
          </button>
        </div>
      </section>

      <section aria-label="서포터 순환">
        <h2>서포터 순환</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.rotationEnabled}
            disabled={busy}
            onChange={(e) =>
              void saveSettings(
                { ...settings, rotationEnabled: e.target.checked },
                e.target.checked
                  ? "서포터 순환을 켰어요. 이전 차례 기록을 이어갑니다."
                  : "서포터 순환을 껐어요. 차례 기록은 지우지 않았습니다.",
              )
            }
          />{" "}
          한 순환 안에서 같은 사람이 서포터를 반복하지 않게 차례를 나눕니다
        </label>
        {settings.rotationEnabled && snapshot.session && (
          <p>
            <span className="hint">이번 순환에서 차례를 쓴 기록 {rotationEvents}건. </span>
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    mutate(`/api/groups/${gid}/rotation/new-cycle`, {
                      requestId: newRequestId(),
                      baseLiveVersion: snapshot.group.liveVersion,
                    } as { requestId: string }),
                  "새 순환을 시작했어요. 전적은 그대로입니다.",
                )
              }
            >
              새 순환 시작
            </button>
          </p>
        )}
      </section>

      <section aria-label="시즌">
        <h2>시즌</h2>
        <p className="hint">
          시즌은 기록을 날짜로 나눠 보는 필터입니다. 배치와 누적 기록은 시즌으로 초기화되지
          않습니다. 시즌끼리는 날짜가 겹칠 수 없습니다.
        </p>
        {snapshot.seasons.length > 0 && (
          <ul className="list">
            {snapshot.seasons.map((s) => (
              <li key={s.id} className="list-row static">
                <span>
                  {s.name}
                  <br />
                  <span className="hint">
                    {s.startsOn} ~ {s.endsOn}
                  </span>
                </span>
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => call("DELETE", `/api/groups/${gid}/seasons/${s.id}`),
                      `'${s.name}' 시즌을 지웠어요. 경기 기록은 그대로입니다.`,
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
            void run(
              () => call("POST", `/api/groups/${gid}/seasons`, seasonForm),
              "시즌을 만들었어요.",
            ).then(() => setSeasonForm({ name: "", startsOn: "", endsOn: "" }));
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
            disabled={
              busy ||
              seasonForm.name.trim() === "" ||
              seasonForm.startsOn === "" ||
              seasonForm.endsOn === ""
            }
          >
            시즌 만들기
          </button>
        </form>
      </section>

      <section aria-label="실력 그룹">
        <h2>실력 그룹 공개</h2>
        <p className="hint">
          실력 그룹은 팀 추천에 쓰는 운영 기준이며 공식 등급이 아닙니다. 공개 여부는 추천 결과를
          바꾸지 않습니다.
        </p>
        <p>
          지금: <strong>{settings.groupsPublic ? "조회자에게 공개" : "운영자만 봄"}</strong>{" "}
          <button type="button" className="link" onClick={() => setPreviewPublic(true)}>
            {settings.groupsPublic ? "비공개로 바꾸기" : "공개로 바꾸기"}
          </button>
        </p>
      </section>

      <section aria-label="참가자">
        <h2>참가자 {people.length}명</h2>
        <ul className="list">
          {people.map((p) => (
            <li key={p.id} className="list-row static">
              <span className="name">
                {p.name}
                {p.status === "archived" && <span className="tag">보관</span>}
              </span>
              <span className="button-row">
                <select
                  aria-label={`${p.name}의 실력 그룹`}
                  value={p.skillGroup ?? ""}
                  disabled={busy}
                  onChange={(e) =>
                    void patchParticipant(
                      p.id,
                      { skillGroup: e.target.value === "" ? null : Number(e.target.value) },
                      `${p.name}의 그룹을 바꿨어요.`,
                    )
                  }
                >
                  <option value="">미지정</option>
                  <option value="1">그룹 1</option>
                  <option value="2">그룹 2</option>
                  <option value="3">그룹 3</option>
                  <option value="4">그룹 4</option>
                </select>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setEditing(p);
                    setEditName(p.name);
                  }}
                >
                  수정
                </button>
              </span>
            </li>
          ))}
          {people.length === 0 && <li className="hint">참가자가 없어요.</li>}
        </ul>
        <label className="toggle">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />{" "}
          보관한 참가자도 보기
        </label>
        <p className="hint">미지정은 낮은 실력이 아니라 아직 정하지 않았다는 뜻입니다.</p>
      </section>

      <section aria-label="표 일괄 입력">
        <h2>표 일괄 입력</h2>
        <p className="hint">
          시트에 적어 둔 지난 경기를 붙여 넣어 한꺼번에 넣습니다. 현재 경기와 서포터 차례에는 영향이
          없습니다.
        </p>
        <button type="button" className="secondary" onClick={() => go("/import")}>
          지난 기록 한꺼번에 넣기
        </button>
        {(snapshot.importBatches ?? []).length > 0 && (
          <ul className="list">
            {(snapshot.importBatches ?? []).map((b) => {
              const allExcluded = b.excluded === b.count;
              return (
                <li key={b.id} className="list-row static">
                  <span>
                    {formatDate(b.importedAt, snapshot.group.timezone)}{" "}
                    {formatTime(b.importedAt, snapshot.group.timezone)} · {b.count}경기
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
                    onClick={() =>
                      void run(
                        () =>
                          mutate(`/api/groups/${gid}/imports/${b.id}`, {
                            requestId: newRequestId(),
                            exclude: !allExcluded,
                          }),
                        allExcluded
                          ? `${b.count}경기를 복구했어요.`
                          : `이때 넣은 경기를 모두 전적 제외했어요. 같은 자리에서 복구할 수 있습니다.`,
                      )
                    }
                  >
                    {allExcluded ? "모두 복구" : "모두 전적 제외"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="운영자 넘기기">
        <h2>운영자 넘기기</h2>
        <p className="hint">
          모임 운영을 다른 사람에게 넘깁니다. 받는 사람이 링크를 열어 수락하면 그 사람이 운영자가
          되고, 이 계정은 더 이상 이 모임을 수정할 수 없습니다. 기록과 조회 링크는 그대로입니다.
        </p>
        <button type="button" className="secondary" onClick={() => setTransferOpen(true)}>
          인수 링크 만들기
        </button>
      </section>

      <section aria-label="백업">
        <h2>백업</h2>
        <p className="hint">
          경기·참가자·설정·변경 이력이 들어갑니다. 계정과 조회 링크는 들어가지 않습니다.
        </p>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const backup = await call<Record<string, unknown>>("GET", `/api/groups/${gid}/export`);
              const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `naejeon-backup-${new Date().toISOString().slice(0, 10)}.json`;
              anchor.click();
              URL.revokeObjectURL(url);
            }, "백업 파일을 내려받았어요.")
          }
        >
          백업 내려받기
        </button>
      </section>

      <p>
        <button type="button" className="link" onClick={() => void app.logout().then(() => go("/"))}>
          로그아웃
        </button>
      </p>

      {previewPublic && (
        <Dialog title="실력 그룹 공개 설정" onClose={() => setPreviewPublic(false)}>
          {settings.groupsPublic ? (
            <p>
              비공개로 바꾸면 조회자에게 실력 그룹이 보이지 않습니다. 이미 본 사람에게는 소용이
              없습니다.
            </p>
          ) : (
            <>
              <p>공개로 바꾸면 조회 링크를 가진 모든 사람에게 이렇게 보입니다.</p>
              <ul className="list">
                {snapshot.participants
                  .filter((p) => p.status === "active")
                  .slice(0, 5)
                  .map((p) => (
                    <li key={p.id} className="list-row static">
                      <span>{p.name}</span>
                      <span>{p.skillGroup ? `그룹 ${p.skillGroup}` : "미지정"}</span>
                    </li>
                  ))}
              </ul>
              <p className="hint">한번 공개된 평가는 되돌릴 수 없습니다.</p>
            </>
          )}
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void saveSettings(
                  { ...settings, groupsPublic: !settings.groupsPublic },
                  settings.groupsPublic ? "비공개로 바꿨어요." : "공개로 바꿨어요.",
                ).then(() => setPreviewPublic(false))
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

      {transferOpen && (
        <Dialog
          title="운영자 넘기기"
          onClose={() => {
            setTransferOpen(false);
            setTransferLink(null);
          }}
        >
          {transferLink === null ? (
            <>
              <p>
                인수 링크는 한 번만 쓸 수 있고 24시간 뒤 만료됩니다. 링크를 받은 사람이 수락하는
                순간 이 계정은 이 모임을 수정할 수 없게 됩니다.
              </p>
              <ErrorNote error={error} />
              <div className="button-row">
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                      const created = await call<{ token: string }>(
                        "POST",
                        `/api/groups/${gid}/transfer`,
                      );
                      setTransferLink(`${location.origin}/#/transfer/${created.token}`);
                    } catch (e) {
                      setError(e);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  인수 링크 만들기
                </button>
                <button type="button" className="secondary" onClick={() => setTransferOpen(false)}>
                  그만두기
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                링크를 만들었어요. 넘겨받을 사람에게만 보내세요. 새 링크를 만들면 이 링크는
                무효가 됩니다.
              </p>
              <CopyButton label="인수 링크 복사" text={() => transferLink} />
            </>
          )}
        </Dialog>
      )}

      {confirmToken && (
        <Dialog title="링크 다시 만들기" onClose={() => setConfirmToken(false)}>
          <p>
            새 링크를 만들면 지금까지 공유한 링크는 더 이상 열리지 않습니다. 참가자에게 새 링크를 다시
            보내야 합니다.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() =>
                void run(
                  () => call("POST", `/api/groups/${gid}/view-token`),
                  "새 링크를 만들었어요.",
                ).then(() => setConfirmToken(false))
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

      {editing && (
        <Dialog title={`${editing.name} 수정`} onClose={() => setEditing(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void patchParticipant(editing.id, { name: editName }, "이름을 바꿨어요.").then(() =>
                setEditing(null),
              );
            }}
          >
            <label>
              이름
              <input value={editName} maxLength={20} onChange={(e) => setEditName(e.target.value)} />
            </label>
            <p className="hint">이름을 바꿔도 과거 경기의 소속과 승패는 그대로입니다.</p>
            <ErrorNote error={error} />
            <div className="button-row">
              <button type="submit" className="primary" disabled={busy || editName.trim() === ""}>
                이름 저장
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void patchParticipant(
                    editing.id,
                    { status: editing.status === "active" ? "archived" : "active" },
                    editing.status === "active"
                      ? "보관했어요. 기록은 그대로 남습니다."
                      : "다시 활성으로 바꿨어요.",
                  ).then(() => setEditing(null))
                }
              >
                {editing.status === "active" ? "보관 (선택 목록에서 숨김)" : "보관 해제"}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
