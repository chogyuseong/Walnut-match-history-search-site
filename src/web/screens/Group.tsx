// 모임 탭. 첫 경기에 필요하지 않은 설정이 여기에 모여 있다.
// 이 파일은 탭 전체가 함께 쓰는 저장 상태(busy·오류·오류 자리)와 묶음 배치만 맡고, 구역마다의 내용과
// 대화 상자는 screens/group/ 아래 파일에 있다. 저장 도구 묶음(GroupKit)의 뜻은 group/kit.ts 참고.
import { useState } from "react";
import type { Settings } from "../../shared/types";
import { mutate, newRequestId, patchParticipant } from "../api";
import { GroupSwitcher, MembershipList } from "../groupSwitcher";
import { LocalAccountSettings } from "../localAccountSettings";
import { ErrorNote, scrollBehavior } from "../ui";
import { go, useAppValue } from "../useApp";
import { CoOperatorSelfSection, CoOperatorsSection } from "./CoOperators";
import { RestoreSection } from "./Restore";
import { TitleSettings } from "./TitleSettings";
import { GroupBlock } from "./group/GroupBlock";
import type { GroupErrorPlace, GroupKit } from "./group/kit";
import { BackupSection, GroupNameSection, TransferSection } from "./group/ManageSettings";
import { NoGroupYet } from "./group/NoGroupYet";
import { PeopleSection } from "./group/PeopleSection";
import { RotationSection, TeamDiversitySection, TierPublicSection } from "./group/PlaySettings";
import { RatingSettings } from "./group/RatingSettings";
import { ImportBatchesSection, RecordEntrySections, SeasonsSection } from "./group/RecordSettings";
import { RequestsSection } from "./group/RequestsSection";
import { ViewLinkSection } from "./group/ViewLinkSection";

/** 구역 바로 가기 단추. id는 GroupBlock id와 같아야 누르면 그 묶음으로 간다. */
const BLOCK_LINKS = [
  ["often", "자주 쓰는 것"],
  ["play", "경기 운영 설정"],
  ["records", "기록 관리"],
  ["group", "모임 관리"],
  ["account", "계정 관리"],
  ["danger", "위험한 작업"],
] as const;

export function Group() {
  const app = useAppValue();
  const snapshot = app.snapshot;
  const [error, setError] = useState<unknown>(null);
  // 마지막 오류를 띄울 구역. null이면 화면 맨 위(group/kit.ts run 주석 참고).
  const [errorPlace, setErrorPlace] = useState<GroupErrorPlace | null>(null);
  const [busy, setBusy] = useState(false);

  if (!snapshot) return <NoGroupYet />;
  const gid = snapshot.group.id;
  const settings = snapshot.group.settings;
  // 공동 운영자에게는 대표 전용 작업(넘기기·복원·모임 삭제·공동 운영자 관리)을 보여주지 않는다. 서버도 거절한다.
  const isOwner = (app.me?.groups.find((g) => g.id === gid)?.role ?? "owner") === "owner";

  const track: GroupKit["track"] = async (work, place) => {
    setBusy(true);
    setError(null);
    setErrorPlace(place ?? null);
    try {
      await work();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const run: GroupKit["run"] = (work, done, place) =>
    track(async () => {
      try {
        await work();
        await app.refreshAfterOwnChange();
      } catch (e) {
        // 실패하면 다른 기기에서 바뀐 내용일 수 있어 기다리지 않고 다시 읽어 둔다.
        void app.refresh();
        throw e;
      }
      if (done) app.setNotice(done);
    }, place);

  const saveSettings = (next: Settings, done: string, place?: GroupErrorPlace) =>
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
      place,
    );

  const kit: GroupKit = {
    app,
    snapshot,
    gid,
    settings,
    busy,
    error,
    clearError: () => setError(null),
    run,
    track,
    saveSettings,
    patchOne: (id, body, done, place) => run(() => patchParticipant(snapshot, id, body), done, place),
    placeError: (place) => (errorPlace === place ? <ErrorNote error={error} /> : null),
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>모임</h1>
      </header>
      <GroupSwitcher />
      <MembershipList />
      {snapshot.group.maintenance && (
        <p className="note error" role="alert">
          백업 복원이 끝나지 않아 이 모임은 점검 중이에요. 맨 아래 '위험한 작업'의 '백업에서 복원'에서 같은 파일로 다시
          실행해 주세요.
        </p>
      )}
      {errorPlace === null && <ErrorNote error={error} />}

      {/* 모임 탭이 길어 원하는 구역으로 바로 간다. 누르면 그 구역을 펼치고 그리로 내려간다. */}
      <nav className="block-nav" aria-label="구역 바로 가기">
        {BLOCK_LINKS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="chip"
            onClick={() => {
              const block = document.getElementById(`group-block-${id}`) as HTMLDetailsElement | null;
              if (!block) return;
              if (!block.open) block.open = true;
              block.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <GroupBlock id="often" title="자주 쓰는 것" defaultOpen>
        <ViewLinkSection kit={kit} />
        <PeopleSection kit={kit} />
        <RequestsSection kit={kit} />
      </GroupBlock>

      <GroupBlock id="play" title="경기 운영 설정" defaultOpen>
        <RotationSection kit={kit} />
        <TeamDiversitySection kit={kit} />
        <TierPublicSection kit={kit} />
      </GroupBlock>

      <GroupBlock id="records" title="기록 관리" defaultOpen>
        <RecordEntrySections />
        <ImportBatchesSection kit={kit} />
        <SeasonsSection kit={kit} />
        <RatingSettings settings={settings} busy={busy} onSave={(next, done) => saveSettings(next, done, "rating")} />
        {kit.placeError("rating")}
        <TitleSettings settings={settings} busy={busy} error={error} onSave={saveSettings} />
      </GroupBlock>

      <GroupBlock id="group" title="모임 관리" defaultOpen>
        <GroupNameSection kit={kit} />
        <BackupSection kit={kit} />
        {isOwner ? <CoOperatorsSection gid={gid} /> : <CoOperatorSelfSection gid={gid} />}
        {isOwner && <TransferSection kit={kit} />}
      </GroupBlock>

      <GroupBlock id="account" title="계정 관리">
        <LocalAccountSettings />
        <section aria-label="로그아웃">
          <h2>로그아웃</h2>
          <p className="hint">이 기기에서 로그아웃해요. 작성 중인 편성은 이 기기에 남아요.</p>
          {kit.placeError("account")}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              // run을 쓰지 않는다: run은 끝나고 스냅숏을 다시 읽는데, 로그아웃 뒤에는 읽을 모임이 없다.
              void track(() => app.logout().then(() => go("/")), "account")
            }
          >
            {busy ? "로그아웃 중" : "로그아웃"}
          </button>
        </section>
      </GroupBlock>

      <GroupBlock id="danger" title="위험한 작업 · 복원 · 삭제" danger forceOpen={snapshot.group.maintenance === true}>
        <p className="hint">되돌리기 어렵거나 기록 전체를 바꾸는 작업이에요. 실행 전에 확인 문구를 입력해야 해요.</p>
        {isOwner && <RestoreSection />}
        <section aria-label="모임 삭제 · 탈퇴">
          <h2>{isOwner ? "모임 삭제 · 탈퇴" : "탈퇴"}</h2>
          <p className="hint">
            {isOwner
              ? "모임의 모든 기록을 지우거나 이 계정을 없애요. 되돌릴 수 없어 확인 문구를 입력해야 해요."
              : "이 계정을 없애요. 모임 삭제와 백업에서 복원은 대표 운영자만 할 수 있어요."}
          </p>
          <button type="button" className="danger" onClick={() => go("/delete")}>
            {isOwner ? "모임 삭제 · 탈퇴로" : "탈퇴로"}
          </button>
        </section>
      </GroupBlock>
    </div>
  );
}
