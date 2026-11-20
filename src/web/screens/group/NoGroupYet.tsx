import { CreateGroupButton } from "../../account";
import { MembershipList } from "../../groupSwitcher";
import { LocalAccountSettings } from "../../localAccountSettings";
import { go, useAppValue } from "../../useApp";
import { NewGroupFromBackup } from "../Restore";
import { GroupBlock } from "./GroupBlock";

/**
 * 로그인했지만 모임이 아직 없는 계정의 모임 탭. 시작하는 세 가지 길을 보여준다.
 * - 오늘 경기부터: 참가자를 고르고 첫 경기를 시작하면 모임이 만들어진다.
 * - 시트·표에 적어 둔 기록부터: 경기를 하지 않고 모임을 먼저 만든 뒤 가져오기 화면으로 간다(app.ensureGroup).
 * - 백업 파일: 빈 모임을 만들지 않고 파일을 바로 새 모임으로 가져온다.
 */
export function NoGroupYet() {
  const app = useAppValue();
  return (
    <div className="screen">
      <h1>모임</h1>
      <MembershipList />
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
