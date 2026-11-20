// 모임 탭 '자주 쓰는 것'의 참가자 목록: 티어 바꾸기, 이름 수정·보관, 본인 연결 링크, 익명 처리, 오래 안 온 사람.
import { useMemo, useState } from "react";
import type { ParticipantView } from "../../../shared/types";
import { call, mutate, newRequestId } from "../../api";
import { resolveMerged } from "../../../shared/merge";
import { nameKey } from "../../../shared/names";
import { ABSENT_DAYS, attendanceReport, longAbsent } from "../../../shared/attendance";
import { formatDate, formatTime, nameMap } from "../../format";
import { Help } from "../../screenKit";
import { CopyButton, Dialog, ErrorNote, useSearchJump } from "../../ui";
import { go } from "../../useApp";
import { AnonymizeDialog } from "./AnonymizeDialog";
import type { GroupKit } from "./kit";

/** 참가자 목록에서 처음 보여주는 사람 수. 이보다 많으면 이름 찾기 칸과 "더 보기"가 나온다. */
const PEOPLE_PREVIEW = 10;

export function PeopleSection({ kit }: { kit: GroupKit }) {
  const { snapshot, gid, busy } = kit;
  const [showArchived, setShowArchived] = useState(false);
  const [peopleQuery, setPeopleQuery] = useState("");
  const peopleJump = useSearchJump<HTMLUListElement>();
  const [allPeople, setAllPeople] = useState(false);
  const [editing, setEditing] = useState<ParticipantView | null>(null);
  const [editName, setEditName] = useState("");
  // 참가자 본인 연결·익명 처리(migrations/0019).
  const [claimUrl, setClaimUrl] = useState<{ participantId: string; url: string } | null>(null);
  const [unlinkFor, setUnlinkFor] = useState<ParticipantView | null>(null);
  const [anonFor, setAnonFor] = useState<ParticipantView | null>(null);
  // 참석 계산은 모임 전체 경기를 훑는다. 스냅숏이 바뀔 때만 다시 계산한다.
  const attendance = useMemo(() => attendanceReport(snapshot.matches, snapshot.group.timezone), [snapshot]);

  const people = snapshot.participants
    .filter((p) => (showArchived ? true : p.status === "active"))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const nameOf = nameMap(snapshot);
  const peopleKey = nameKey(peopleQuery);
  const matchedPeople = peopleKey === "" ? people : people.filter((p) => nameKey(p.name).includes(peopleKey));
  const listedPeople = allPeople || peopleKey !== "" ? matchedPeople : matchedPeople.slice(0, PEOPLE_PREVIEW);
  const linkOf = new Map((snapshot.memberLinks ?? []).map((l) => [l.participantId, l]));
  const claimOf = new Map((snapshot.memberClaims ?? []).map((c) => [c.participantId, c]));
  const tz = snapshot.group.timezone;
  // 오래 안 온 사람(attendance.ts): 모임 전체 기간의 모임 날 기준.
  const absent = longAbsent(attendance, snapshot.participants, nameOf);

  return (
    <section aria-label="참가자">
      <h2>참가자 {people.length}명</h2>
      {people.length > PEOPLE_PREVIEW && (
        <label>
          참가자 이름으로 찾기
          <input
            type="search"
            autoComplete="off"
            enterKeyHint="search"
            value={peopleQuery}
            onChange={(e) => setPeopleQuery(e.target.value)}
            onKeyDown={peopleJump.onSearchKey}
          />
        </label>
      )}
      <ul ref={peopleJump.results} tabIndex={-1} className="list list-card search-results">
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
                {linkOf.has(p.id) && <span className="tag">연결됨</span>}
              </span>
              <span className="button-row">
                <select
                  aria-label={`${p.name}의 티어`}
                  value={p.skillGroup ?? ""}
                  disabled={busy}
                  onChange={(e) =>
                    void kit.patchOne(
                      p.id,
                      { skillGroup: e.target.value === "" ? null : Number(e.target.value) },
                      `${p.name}의 티어를 바꿨어요.`,
                      "people",
                    )
                  }
                >
                  <option value="">미지정</option>
                  <option value="1">1티어</option>
                  <option value="2">2티어</option>
                  <option value="3">3티어</option>
                  <option value="4">4티어</option>
                  <option value="5">5티어</option>
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
      {kit.placeError("people")}
      {matchedPeople.length > listedPeople.length && (
        <button type="button" className="link" onClick={() => setAllPeople(true)}>
          나머지 {matchedPeople.length - listedPeople.length}명 더 보기
        </button>
      )}
      <label className="toggle">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> 보관한 참가자도
        보기
      </label>
      {absent.length === 0 ? (
        <p className="hint">오래 안 온 사람 없음(모임 날 {ABSENT_DAYS}번 이상 빠진 활성 참가자)</p>
      ) : (
        <details>
          <summary>오래 안 온 사람 {absent.length}명</summary>
          <p className="hint">마지막으로 온 뒤 모임 날이 {ABSENT_DAYS}번 이상 지난 활성 참가자예요. 오래 안 온 순.</p>
          <ul className="list" aria-label="오래 안 온 사람">
            {absent.map((a) => (
              <li key={a.participantId} className="list-row static">
                <span className="name">{nameOf(a.participantId)}</span>
                <span className="stat">
                  마지막 {formatDate(a.lastDate, tz)} · 그 뒤 모임 {a.missedSinceLast}번
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <Help>
        티어: 1티어가 가장 잘하는 사람이에요. 같은 티어끼리는 팀·라인 모두 섞기·팀 추천에서 양 팀에 나뉘어요. 미지정은
        못하는 사람이 아니라 아직 안 정한 사람이에요.
      </Help>
      <button type="button" className="secondary" onClick={() => go("/priority")}>
        티어 배정
      </button>
      <p className="hint">같은 사람이 다른 이름으로 두 번 들어갔나요?</p>
      <button type="button" className="secondary" onClick={() => go("/merge")}>
        중복 참가자 합치기
      </button>
      <Help label="본인 연결이란">
        본인 연결: 사람마다 '수정'에서 연결 링크를 만들어 본인에게 보내면, 본인이 로그인해 자기 이름과 계정을 묶어요. 연결한
        사람은 내 전적·내 기피 라인·본인 확인 참가 신청·정정 요청을 쓸 수 있고, 기록은 운영자만 고쳐요.
      </Help>

      {editing && (
        <Dialog title={`${editing.name} 수정`} onClose={() => setEditing(null)}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              // 실패(다른 기기에서 먼저 고침 등)하면 대화 상자와 입력한 이름을 그대로 둔다.
              void kit.patchOne(editing.id, { name: editName }, "이름을 바꿨어요.").then((ok) => ok && setEditing(null));
            }}
          >
            <label>
              이름
              <input value={editName} maxLength={20} onChange={(e) => setEditName(e.target.value)} />
            </label>
            <p className="hint">이름을 바꿔도 과거 경기의 소속과 승패는 그대로예요.</p>
            <ErrorNote error={kit.error} />
            <div className="button-row">
              <button type="submit" className="primary" disabled={busy || editName.trim() === ""}>
                이름 저장
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void kit
                    .patchOne(
                      editing.id,
                      { status: editing.status === "active" ? "archived" : "active" },
                      editing.status === "active" ? "보관했어요. 기록은 그대로 남아요." : "다시 활성으로 바꿨어요.",
                    )
                    .then((ok) => ok && setEditing(null))
                }
              >
                {editing.status === "active" ? "보관 (선택 목록에서 숨김)" : "보관 해제"}
              </button>
            </div>
          </form>
          <section aria-label="본인 연결" className="dialog-section">
            <h3>본인 연결</h3>
            {(() => {
              const link = linkOf.get(editing.id);
              const claim = claimOf.get(editing.id);
              if (link) {
                return (
                  <>
                    <p>
                      <span className="tag">연결됨</span> {formatDate(link.linkedAt, tz)}부터 본인 계정과 연결돼 있어요.
                    </p>
                    <button type="button" className="link" disabled={busy} onClick={() => setUnlinkFor(editing)}>
                      연결 끊기
                    </button>
                  </>
                );
              }
              if (claimUrl?.participantId === editing.id) {
                return (
                  <>
                    <p className="hint">
                      링크를 만들었어요. {editing.name} 님 본인에게만 보내세요. 한 번만 쓸 수 있고 24시간 뒤 만료돼요.
                    </p>
                    <CopyButton label="연결 링크 복사" text={() => claimUrl.url} />
                  </>
                );
              }
              return (
                <>
                  <p className="hint">
                    {claim
                      ? `보낸 연결 링크가 ${formatDate(claim.expiresAt, tz)} ${formatTime(claim.expiresAt, tz)}까지 유효해요. 링크 주소는 다시 볼 수 없어요. 새로 만들면 이전 링크는 무효가 돼요.`
                      : "연결 링크를 만들어 본인에게 보내면, 본인이 로그인해 이 이름과 계정을 묶어요(1회용, 24시간)."}
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      const person = editing;
                      void kit.run(async () => {
                        const created = await call<{ token: string }>(
                          "POST",
                          `/api/groups/${gid}/participants/${person.id}/claim-link`,
                        );
                        setClaimUrl({ participantId: person.id, url: `${location.origin}/#/claim/${created.token}` });
                      });
                    }}
                  >
                    {claim ? "새 연결 링크 만들기" : "연결 링크 만들기"}
                  </button>
                </>
              );
            })()}
          </section>
          <section aria-label="익명 처리" className="dialog-section">
            <h3>익명 처리</h3>
            <p className="hint">본인이 기록 삭제를 원할 때 써요. 이름을 지우고 경기 기록은 이름 없이 남겨요. 되돌릴 수 없어요.</p>
            <button type="button" className="danger" onClick={() => setAnonFor(editing)}>
              익명 처리…
            </button>
          </section>
        </Dialog>
      )}

      {unlinkFor && (
        <Dialog title="연결 끊기" onClose={() => setUnlinkFor(null)}>
          <p>
            <strong>{unlinkFor.name}</strong>과(와) 연결된 계정의 연결을 끊어요. 그 계정은 바로 이 모임의 내 정보를 볼 수 없게 되고,
            기록은 그대로예요.
          </p>
          <ErrorNote error={kit.error} />
          <div className="button-row">
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                const person = unlinkFor;
                void kit
                  .run(
                    () => mutate(`/api/groups/${gid}/participants/${person.id}/link`, { requestId: newRequestId() }, "DELETE"),
                    "연결을 끊었어요.",
                  )
                  .then((ok) => ok && setUnlinkFor(null));
              }}
            >
              연결 끊기
            </button>
            <button type="button" className="secondary" onClick={() => setUnlinkFor(null)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}

      <AnonymizeDialog
        kit={kit}
        person={anonFor}
        onClose={() => setAnonFor(null)}
        onDone={() => {
          setAnonFor(null);
          setEditing(null);
        }}
      />
    </section>
  );
}
