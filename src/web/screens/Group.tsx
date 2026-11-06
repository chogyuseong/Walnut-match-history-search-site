import { useState, type ReactNode } from "react";
import type { ParticipantView, Settings } from "../../shared/types";
import { ApiFailure, call, mutate, newRequestId } from "../api";
import { resolveMerged } from "../../shared/merge";
import { nameKey } from "../../shared/names";
import { formatDate, formatTime, nameMap, viewLink } from "../format";
import { rotationContext, supportCounts } from "../../shared/rotation";
import { SupportCountEditor } from "../supportCountEditor";
import { CopyButton, Dialog, ErrorNote } from "../ui";
import { go, useAppValue } from "../useApp";
import { TitleSettings } from "./TitleSettings";
import { NewGroupFromBackup, RestoreSection } from "./Restore";
import { CreateGroupButton, LocalAccountSettings } from "../account";
import { CoOperatorSelfSection, CoOperatorsSection } from "./CoOperators";

/** 모임 탭 참가자 목록에서 처음 보여주는 사람 수. */
const PEOPLE_PREVIEW = 10;

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
  const [peopleQuery, setPeopleQuery] = useState("");
  const [allPeople, setAllPeople] = useState(false);
  const [seasonForm, setSeasonForm] = useState({ name: "", startsOn: "", endsOn: "" });
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferLink, setTransferLink] = useState<string | null>(null);
  // 묶음 복구에서 이미 기록에 있는 경기와 겹친 경우: 겹치지 않는 경기만 복구할지 고르게 한다.
  const [restoreOverlap, setRestoreOverlap] = useState<{ batchId: string; overlapping: number; restorable: number } | null>(
    null,
  );

  if (!snapshot) return <NoGroupYet />;
  const gid = snapshot.group.id;
  const settings = snapshot.group.settings;
  // 공동 운영자에게는 대표 전용 작업(넘기기·복원·모임 삭제·공동 운영자 관리)을 보여주지 않는다. 서버도 거절한다.
  const isOwner = (app.me?.groups.find((g) => g.id === gid)?.role ?? "owner") === "owner";

  /** 저장하고 최신 상태를 다시 읽는다. 성공하면 true를 돌려준다. */
  async function run(work: () => Promise<unknown>, done?: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await work();
      await app.refreshAfterOwnChange();
      if (done) app.setNotice(done);
      return true;
    } catch (e) {
      setError(e);
      void app.refresh();
      return false;
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
  const nameOf = nameMap(snapshot);
  // 참가자가 많으면 처음에는 PEOPLE_PREVIEW명만 보이고, 이름으로 찾거나 "더 보기"로 편다.
  const peopleKey = nameKey(peopleQuery);
  const matchedPeople = peopleKey === "" ? people : people.filter((p) => nameKey(p.name).includes(peopleKey));
  const listedPeople = allPeople || peopleKey !== "" ? matchedPeople : matchedPeople.slice(0, PEOPLE_PREVIEW);
  const rotationEvents = snapshot.rotation?.events.length ?? 0;

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>모임</h1>
      </header>
      {snapshot.group.maintenance && (
        <p className="note warn" role="alert">
          백업 복원이 끝나지 않아 이 모임은 점검 중이에요. 맨 아래 '위험한 작업'의 '백업에서 복원'에서 같은 파일로 다시
          실행해 주세요.
        </p>
      )}
      <ErrorNote error={error} />

      <GroupBlock id="often" title="자주 쓰는 것" defaultOpen>
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
        <section aria-label="참가자">
          <h2>참가자 {people.length}명</h2>
          {people.length > PEOPLE_PREVIEW && (
            <input
              type="search"
              aria-label="참가자 이름으로 찾기"
              placeholder="이름으로 찾기"
              autoComplete="off"
              value={peopleQuery}
              onChange={(e) => setPeopleQuery(e.target.value)}
            />
          )}
          <ul className="list">
            {listedPeople.map((p) =>
              p.mergedInto ? (
                // 합쳐진 이름: 기록은 모두 남은 사람에게 옮겨졌다. 되돌리기는 합치기 화면에서 한다.
                <li key={p.id} className="list-row static">
                  <span className="name">
                    {p.name}
                    <br />
                    <span className="hint">{nameOf(resolveMerged(snapshot.participants, p.id))}에게 합쳐짐</span>
                  </span>
                  <button type="button" className="link" onClick={() => go("/merge")}>
                    합친 기록 보기
                  </button>
                </li>
              ) : (
              <li key={p.id} className="list-row static">
                <span className="name">
                  {p.name}
                  {p.status === "archived" && <span className="tag">보관</span>}
                </span>
                <span className="button-row">
                  <select
                    aria-label={`${p.name}의 우선순위`}
                    value={p.skillGroup ?? ""}
                    disabled={busy}
                    onChange={(e) =>
                      void patchParticipant(
                        p.id,
                        { skillGroup: e.target.value === "" ? null : Number(e.target.value) },
                        `${p.name}의 우선순위를 바꿨어요.`,
                      )
                    }
                  >
                    <option value="">미지정</option>
                    <option value="1">1순위</option>
                    <option value="2">2순위</option>
                    <option value="3">3순위</option>
                    <option value="4">4순위</option>
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
              ),
            )}
            {people.length === 0 && <li className="hint">참가자가 없어요.</li>}
            {people.length > 0 && matchedPeople.length === 0 && <li className="hint">일치하는 이름이 없어요.</li>}
          </ul>
          {matchedPeople.length > listedPeople.length && (
            <button type="button" className="link" onClick={() => setAllPeople(true)}>
              나머지 {matchedPeople.length - listedPeople.length}명 더 보기
            </button>
          )}
          <label className="toggle">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />{" "}
            보관한 참가자도 보기
          </label>
          <p className="hint">
            우선순위: 1순위가 가장 잘하는 사람이에요. 같은 순위끼리는 팀까지 올랜덤·팀 추천에서 양 팀에 나뉘어요. 미지정은
            못하는 사람이 아니라 아직 안 정한 사람이에요.
          </p>
          <button type="button" className="secondary" onClick={() => go("/priority")}>
            우선순위 배정
          </button>
          <p className="hint">같은 사람이 다른 이름으로 두 번 들어갔나요?</p>
          <button type="button" className="secondary" onClick={() => go("/merge")}>
            중복 참가자 합치기
          </button>
        </section>
      </GroupBlock>

      <GroupBlock id="play" title="경기 운영 설정" defaultOpen>
        <section aria-label="서포터 횟수">
          <h2>서포터 횟수</h2>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.rotationEnabled}
              disabled={busy}
              onChange={(e) =>
                void saveSettings(
                  { ...settings, rotationEnabled: e.target.checked },
                  e.target.checked
                    ? "서포터 횟수를 다시 셉니다. 이전 기록을 이어갑니다."
                    : "서포터 횟수 세기를 껐어요. 기록은 지우지 않았습니다.",
                )
              }
            />{" "}
            서포터로 간 횟수를 세고, 같은 팀에서 아직 서포터를 안 간 사람을 서포터로 고릅니다
          </label>
          {settings.rotationEnabled && (snapshot.session || snapshot.rotation) && (
            <p>
              <span className="hint">지금까지 서포터로 간 기록 {rotationEvents}건. </span>
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
                    "서포터 횟수를 초기화했어요. 전적은 그대로입니다.",
                  )
                }
              >
                서포터 횟수 초기화
              </button>
            </p>
          )}
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
              />
            </details>
          )}
        </section>
        <section aria-label="팀 추천">
          <h2>팀 추천</h2>
          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.teamDiversity !== false}
              disabled={busy}
              onChange={(e) =>
                void saveSettings(
                  { ...settings, teamDiversity: e.target.checked },
                  e.target.checked
                    ? "팀 추천에서 최근 조합을 피하도록 했어요."
                    : "팀 추천이 최근 조합을 따지지 않도록 했어요.",
                )
              }
            />{" "}
            우선순위 균형이 같은 후보 중에서 최근 8경기에 같은 팀이었던 사람끼리 덜 묶이는 조합을 먼저 추천합니다
          </label>
          <p className="hint">균형(우선순위 합계·인원)과 같은 팀·다른 팀 조건이 항상 먼저입니다.</p>
        </section>
        <section aria-label="우선순위 공개">
          <h2>우선순위 공개</h2>
          <p className="hint">
            우선순위는 팀 추천·팀까지 올랜덤에 쓰는 운영 기준이며 공식 등급이 아닙니다. 공개 여부는 추천·섞기 결과를
            바꾸지 않습니다.
          </p>
          <p>
            지금: <strong>{settings.groupsPublic ? "조회자에게 공개" : "운영자만 봄"}</strong>{" "}
            <button type="button" className="link" onClick={() => setPreviewPublic(true)}>
              {settings.groupsPublic ? "비공개로 바꾸기" : "공개로 바꾸기"}
            </button>
          </p>
        </section>
      </GroupBlock>

      <GroupBlock id="records" title="기록 관리" defaultOpen>
        <section aria-label="지난 경기 입력">
          <h2>지난 경기 입력</h2>
          <p className="hint">
            이미 끝난 경기 하나를 결과까지 넣습니다. 오늘 내전과 서포터 횟수에는 영향이 없습니다.
          </p>
          <button type="button" className="secondary" onClick={() => go("/backfill")}>
            지난 경기 한 건 넣기
          </button>
        </section>
        <section aria-label="표 일괄 입력">
          <h2>표 일괄 입력</h2>
          <p className="hint">
            시트에 적어 둔 지난 경기를 붙여 넣어 한꺼번에 넣습니다. 현재 경기와 서포터 횟수에는 영향이
            없습니다.
          </p>
          <button type="button" className="secondary" onClick={() => go("/import")}>
            지난 기록 한꺼번에 넣기
          </button>
          <button type="button" className="secondary" onClick={() => go("/sheet-import")}>구글 시트에서 가져오기</button>
          <button type="button" className="secondary" onClick={() => go("/legacy-import")}>
            기존 사이트 기록 가져오기
          </button>
          <p className="hint">
            기존 사이트(구글 시트 + 연결 주소)를 쓰던 모임은 그때 쓰던 연결 주소(script.google.com/macros/s/…/exec)로
            기록을 그대로 옮길 수 있어요. 구글 시트 주소와는 다른 주소예요.
          </p>
          {(snapshot.importBatches ?? []).length > 0 && (
            <ul className="list">
              {(snapshot.importBatches ?? []).map((b) => {
                const allExcluded = b.excluded === b.count;
                return (
                  <li key={b.id} className="list-row static">
                    <span>
                      {formatDate(b.importedAt, snapshot.group.timezone)}{" "}
                      {formatTime(b.importedAt, snapshot.group.timezone)} · {b.count}경기
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
                        void run(
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
                                  overlapping: (e.details?.overlaps ?? []).length,
                                  restorable: Number(e.details?.restorable ?? 0),
                                });
                              }
                              throw e;
                            }
                          },
                          allExcluded
                            ? `${b.count}경기를 복구했어요.`
                            : `이때 넣은 경기를 모두 전적 제외했어요. 같은 자리에서 복구할 수 있습니다.`,
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
                              void run(
                                () =>
                                  mutate(`/api/groups/${gid}/imports/${b.id}`, {
                                    requestId: newRequestId(),
                                    exclude: false,
                                    skipOverlapping: true,
                                  }),
                                `겹치지 않는 ${count}경기를 복구했어요.`,
                              ).then((ok) => {
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
        <TitleSettings settings={settings} busy={busy} error={error} onSave={saveSettings} />
      </GroupBlock>

      <GroupBlock id="group" title="모임 관리" defaultOpen>
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
        {isOwner ? <CoOperatorsSection gid={gid} /> : <CoOperatorSelfSection gid={gid} />}
        {isOwner && (
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
        )}
      </GroupBlock>

      <GroupBlock id="account" title="계정 관리">
        <LocalAccountSettings />
        <section aria-label="로그아웃">
          <h2>로그아웃</h2>
          <p className="hint">이 기기에서 로그아웃합니다. 작성 중인 편성은 이 기기에 남습니다.</p>
          <button type="button" className="secondary" onClick={() => void app.logout().then(() => go("/"))}>
            로그아웃
          </button>
        </section>
      </GroupBlock>

      <GroupBlock id="danger" title="위험한 작업 · 복원 · 삭제" danger forceOpen={snapshot.group.maintenance === true}>
        <p className="hint">되돌리기 어렵거나 기록 전체를 바꾸는 작업입니다. 실행 전에 확인 문구를 입력해야 합니다.</p>
        {isOwner && <RestoreSection />}
        <section aria-label="모임 삭제 · 탈퇴">
          <h2>{isOwner ? "모임 삭제 · 탈퇴" : "탈퇴"}</h2>
          <p className="hint">
            {isOwner
              ? "모임의 모든 기록을 지우거나 이 계정을 없앱니다. 되돌릴 수 없어 확인 문구를 입력해야 합니다."
              : "이 계정을 없앱니다. 모임 삭제와 백업에서 복원은 대표 운영자만 할 수 있어요."}
          </p>
          <button type="button" className="danger" onClick={() => go("/delete")}>
            {isOwner ? "모임 삭제 · 탈퇴로" : "탈퇴로"}
          </button>
        </section>
      </GroupBlock>


      {previewPublic && (
        <Dialog title="우선순위 공개 설정" onClose={() => setPreviewPublic(false)}>
          {settings.groupsPublic ? (
            <p>
              비공개로 바꾸면 조회자에게 우선순위가 보이지 않습니다. 이미 본 사람에게는 소용이
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
                      <span>{p.skillGroup ? `${p.skillGroup}순위` : "미지정"}</span>
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

/**
 * 모임 탭의 묶음. 접고 펼 수 있고, 펼친 상태는 이 창에서 기억한다(다른 화면에 갔다 와도 그대로).
 * forceOpen이면 항상 펼친다(점검 중일 때 복원 구역).
 */
/**
 * 로그인했지만 모임이 아직 없는 계정의 모임 탭. 시작하는 세 가지 길을 보여준다.
 * - 오늘 경기부터: 참가자를 고르고 첫 경기를 시작하면 모임이 만들어진다.
 * - 시트·표에 적어 둔 기록부터: 경기를 하지 않고 모임을 먼저 만든 뒤 가져오기 화면으로 간다(app.ensureGroup).
 * - 백업 파일: 빈 모임을 만들지 않고 파일을 바로 새 모임으로 가져온다.
 */
function NoGroupYet() {
  const app = useAppValue();
  return (
    <div className="screen">
      <h1>모임</h1>
      <p>아직 모임이 없어요. 어떻게 시작할지 골라 주세요.</p>
      <section className="card start-card" aria-label="오늘 경기부터">
        <h2>오늘 경기부터</h2>
        <p className="hint">참가자를 고르고 첫 경기를 시작하면 모임이 만들어져요.</p>
        <button type="button" className="primary" onClick={() => go("/pick")}>
          참가자 고르기
        </button>
      </section>
      <section className="card start-card" aria-label="적어 둔 기록부터">
        <h2>시트에 적어 둔 기록부터</h2>
        <p className="hint">
          경기를 하지 않아도 모임을 먼저 만들고 지난 기록을 넣을 수 있어요. 지금 경기와 서포터 횟수에는 영향이
          없어요.
        </p>
        <div className="button-row">
          <CreateGroupButton label="모임 만들고 구글 시트에서 가져오기" to="/sheet-import" />
          <CreateGroupButton label="모임 만들고 표 붙여 넣기" to="/import" />
        </div>
      </section>
      <section className="card start-card" aria-label="기존 사이트 기록부터">
        <h2>기존 사이트에서 옮겨 오기</h2>
        <p className="hint">
          기존 사이트(구글 시트 + 연결 주소)를 쓰던 모임이면, 그때 쓰던 연결 주소(script.google.com/macros/s/…/exec)로
          경기 기록을 라인·날짜 그대로 옮겨 와요. 구글 시트 주소와는 다른 주소예요. 기존 기록은 읽기만 해요.
        </p>
        <div className="button-row">
          <CreateGroupButton label="모임 만들고 기존 사이트 기록 가져오기" to="/legacy-import" />
        </div>
      </section>
      <NewGroupFromBackup />
      {app.me?.loginMethod === "local" && (
        <GroupBlock id="account" title="계정 관리">
          <LocalAccountSettings />
        </GroupBlock>
      )}
      <p>
        <button type="button" className="link" onClick={() => go("/delete")}>
          탈퇴(계정 삭제)
        </button>
      </p>
    </div>
  );
}

function GroupBlock(props: {
  id: string;
  title: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  const key = `naejeon.groupBlock.${props.id}`;
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = sessionStorage.getItem(key);
      if (stored !== null) return stored === "1";
    } catch {
      // 기억하지 못하면 기본값.
    }
    return props.defaultOpen === true;
  });
  return (
    <details
      className={props.danger ? "group-block danger-block" : "group-block"}
      open={open || props.forceOpen === true}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open;
        setOpen(next);
        try {
          sessionStorage.setItem(key, next ? "1" : "0");
        } catch {
          // 무시
        }
      }}
    >
      <summary>{props.title}</summary>
      <div className="group-block-body">{props.children}</div>
    </details>
  );
}
