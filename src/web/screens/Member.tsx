import { useCallback, useEffect, useState } from "react";
import { MAX_AVOID } from "../../shared/avoid";
import { MEMO_MAX, memoLength } from "../../shared/memo";
import {
  POSITIONS,
  type MemberRequestKind,
  type MemberRequestStatus,
  type MemberRequestView,
  type Position,
  type Snapshot,
} from "../../shared/types";
import { ApiFailure, call } from "../api";
import { formatDate, formatTime, nameMap, POSITION_LABEL, STATE_LABEL, teamName } from "../format";
import { Dialog, ErrorNote, MatchTeams, PosLabel } from "../ui";
import { go, useAppValue } from "../useApp";
import { Dashboard } from "./Dashboard";
import { LoginDialog } from "./Login";
import { MaintenanceNote, ViewerNav, viewerPage } from "./Viewer";

/** 서버 상한(src/server/members.ts)과 같은 값. */
const REQUEST_TEXT_MAX = MEMO_MAX;
const MAX_OPEN_REQUESTS = 5;

export const REQUEST_KIND_LABEL: Record<MemberRequestKind, string> = {
  correction: "경기 결과 정정 요청",
  erase: "기록 삭제·익명 처리 요청",
};

export const REQUEST_STATUS_LABEL: Record<MemberRequestStatus, string> = {
  open: "처리 대기",
  done: "처리함",
  declined: "반려",
};

/**
 * 참가 중인 모임(#/mine/모임ID/...). 참가자로 연결한 계정(멤버)이 보는 화면.
 * 조회 링크와 같은 읽기 전용 화면(viewerPage)을 토큰 없이 연다. 서버 응답도 조회 링크와 같은 직렬화 함수를 쓰고,
 * 내 것(me: 내 참가자 ID·내 기피 라인·내 요청)만 더해 온다.
 * 첫 화면 "내 정보": 내 전적 바로 가기, 내 기피 라인, 요청 남기기·내 요청 상태, 연결 끊기.
 */
export function Member(props: { gid: string; rest: string[] }) {
  const { gid, rest } = props;
  const app = useAppValue();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setSnapshot(await call<Snapshot>("GET", `/api/member/${gid}/snapshot`));
      setLoadedAt(Date.now());
      setError(null);
    } catch (e) {
      if (e instanceof ApiFailure) setError(e);
    }
  }, [gid]);

  useEffect(() => {
    void load();
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  if (!snapshot || !snapshot.me) {
    return (
      <div className="screen">
        {error ? (
          <p className="note warn" role="alert">
            {error.status === 404
              ? "이 모임과의 연결이 없어요. 연결이 끊겼거나 운영자가 정리했을 수 있어요. 다시 연결하려면 운영자에게 새 연결 링크를 받아 주세요."
              : "불러오지 못했어요."}{" "}
            {error.status !== 404 && (
              <button type="button" className="link" onClick={() => void load()}>
                다시 불러오기
              </button>
            )}
          </p>
        ) : (
          <p>불러오는 중…</p>
        )}
      </div>
    );
  }

  const base = `/mine/${gid}`;
  const me = snapshot.me;
  const shared = viewerPage(snapshot, base, rest);
  const shell = (current: Parameters<typeof ViewerNav>[0]["current"], body: React.ReactNode) => (
    <>
      <ViewerNav base={base} group={snapshot.group.name} current={current} member />
      {snapshot.group.maintenance && <MaintenanceNote />}
      {body}
    </>
  );
  if (shared) return shell(shared.tab, shared.body);
  if (rest[0] === "now") return shell("now", <CurrentMatch snapshot={snapshot} meId={me.participantId} base={base} />);
  return shell(
    "me",
    <MemberHome
      snapshot={snapshot}
      base={base}
      gid={gid}
      reload={load}
      loadedAt={loadedAt}
      loadError={error}
      onUnlinked={() => {
        void app.reloadMe().then(() => {
          app.setNotice("연결을 끊었어요.");
          go("/");
        });
      }}
    />,
  );
}

/** 현재 경기(조회 링크의 첫 화면과 같은 내용). 내 이름은 연결한 참가자로 정해져 있다. */
function CurrentMatch(props: { snapshot: Snapshot; meId: string; base: string }) {
  const { snapshot, meId, base } = props;
  const nameOf = nameMap(snapshot);
  const match =
    snapshot.matches.find((m) => m.state === "in_progress") ??
    [...snapshot.matches]
      .filter((m) => m.state !== "canceled" && m.source === "live")
      .sort((a, b) => b.matchNo - a.matchNo)[0] ??
    null;
  if (!match) {
    return (
      <div className="screen">
        <p>아직 시작한 경기가 없어요.</p>
        <Dashboard
          snapshot={snapshot}
          openMatch={(id) => go(`${base}/d/${id}`)}
          openPerson={(id) => go(`${base}/p/${id}`)}
          openRanking={() => go(`${base}/records`)}
        />
      </div>
    );
  }
  const seat = match.roster.find((r) => r.participantId === meId) ?? null;
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>
          {match.matchNo}경기 · {STATE_LABEL[match.state]}
        </h1>
        <span className="badge">확정 명단</span>
      </header>
      <section className="card">
        {seat ? (
          <p>
            <strong>{nameOf(seat.participantId)}</strong> 님 · {teamName(seat.team, match.teamASide)} ·{" "}
            {seat.position ? POSITION_LABEL[seat.position] : "포지션 없음"}
          </p>
        ) : (
          <p>{nameOf(meId)} 님은 이 경기에 없어요.</p>
        )}
      </section>
      <MatchTeams match={match} nameOf={nameOf} highlightId={meId} />
      <p className="hint">팀 편성 기준은 운영자가 정합니다.</p>
    </div>
  );
}

function MemberHome(props: {
  snapshot: Snapshot;
  base: string;
  gid: string;
  reload: () => Promise<void>;
  loadedAt: number | null;
  loadError: ApiFailure | null;
  onUnlinked: () => void;
}) {
  const { snapshot, base, gid } = props;
  const app = useAppValue();
  const me = snapshot.me!;
  const nameOf = nameMap(snapshot);
  const myName = nameOf(me.participantId);
  const tz = snapshot.group.timezone;
  const [avoidPending, setAvoidPending] = useState<Position[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<MemberRequestKind>("correction");
  const [matchId, setMatchId] = useState("");
  const [text, setText] = useState("");
  const [unlinkOpen, setUnlinkOpen] = useState(false);

  const avoid = avoidPending ?? me.avoidPositions;
  const myMatches = snapshot.matches
    .filter((m) => m.roster.some((r) => r.participantId === me.participantId))
    .sort((a, b) => (a.playedAt < b.playedAt ? 1 : a.playedAt > b.playedAt ? -1 : b.matchNo - a.matchNo))
    .slice(0, 50);
  const openCount = me.requests.filter((r) => r.status === "open").length;
  const full = openCount >= MAX_OPEN_REQUESTS;
  const length = memoLength(text.trim());
  const matchNoOf = (id: string | null) => snapshot.matches.find((m) => m.id === id)?.matchNo;

  async function saveAvoid(next: Position[]) {
    setAvoidPending(next);
    setError(null);
    try {
      await call("PUT", `/api/member/${gid}/avoid`, { avoidPositions: next });
      await props.reload();
      app.setNotice(next.length === 0 ? "기피 라인을 비웠어요." : `기피 라인: ${next.map((p) => POSITION_LABEL[p]).join("·")}`);
    } catch (e) {
      setError(e);
    } finally {
      setAvoidPending(null);
    }
  }

  async function sendRequest() {
    setBusy(true);
    setError(null);
    try {
      await call("POST", `/api/member/${gid}/requests`, kind === "correction" ? { kind, matchId, text } : { kind, text });
      setText("");
      setMatchId("");
      await props.reload();
      app.setNotice("요청을 남겼어요. 운영자가 확인하면 여기서 상태를 볼 수 있어요.");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen member-home">
      <header className="screen-head">
        <h1>내 정보</h1>
      </header>
      <section className="card" aria-label="내 이름">
        <p>
          이 계정은 <strong>{snapshot.group.name}</strong>의 <strong>{myName}</strong> 님과 연결돼 있어요.
        </p>
        <div className="button-row">
          <button type="button" className="primary" onClick={() => go(`${base}/p/${me.participantId}`)}>
            내 전적 보기
          </button>
          <button type="button" className="secondary" onClick={() => go(`${base}/now`)}>
            현재 경기에서 내 자리
          </button>
        </div>
        <p className="hint">기록은 운영자만 고쳐요. 잘못된 기록은 아래에서 정정을 요청해 주세요.</p>
      </section>

      <ErrorNote error={error} />

      <section aria-label="내 기피 라인">
        <h2>내 기피 라인</h2>
        <p className="hint">
          고른 라인은 운영자가 라인을 섞을 때 되도록 피해요(꼭 지켜지지는 않아요). 한 사람에 {MAX_AVOID}개까지, 누르면 바로
          저장돼요. 운영자와 나만 봐요. 운영자가 바꿀 수도 있어요.
        </p>
        <span className="segmented" role="group" aria-label="내 기피 라인">
          {POSITIONS.map((position) => {
            const on = avoid.includes(position);
            const blocked = !on && avoid.length >= MAX_AVOID;
            return (
              <button
                key={position}
                type="button"
                aria-label={`${POSITION_LABEL[position]} 기피`}
                aria-pressed={on}
                aria-disabled={blocked || undefined}
                disabled={avoidPending !== null}
                onClick={() => {
                  if (blocked) {
                    app.setNotice(`기피 라인은 ${MAX_AVOID}개까지예요. 한 라인은 갈 수 있어야 해요.`);
                    return;
                  }
                  void saveAvoid(
                    on ? avoid.filter((p) => p !== position) : POSITIONS.filter((p) => p === position || avoid.includes(p)),
                  );
                }}
              >
                <PosLabel position={position} />
              </button>
            );
          })}
        </span>
        <p className="hint">
          {avoid.length === 0
            ? "지금: 없음"
            : `지금: ${avoid.map((p) => POSITION_LABEL[p]).join("·")} · ${me.avoidBySelf ? "내가 정함" : "운영자가 정함"}`}
        </p>
      </section>

      <section aria-label="요청 남기기">
        <h2>요청 남기기</h2>
        <p className="hint">
          요청은 운영자에게만 보이고, 기록은 운영자가 확인한 뒤 고쳐요. 처리를 기다리는 요청은 {MAX_OPEN_REQUESTS}개까지예요(지금{" "}
          {openCount}개).
        </p>
        <form
          className="member-request-form"
          onSubmit={(event) => {
            event.preventDefault();
            void sendRequest();
          }}
        >
          <fieldset className="segmented-field">
            <legend className="hint">무엇을 요청할까요?</legend>
            {(["correction", "erase"] as const).map((k) => (
              <label key={k} className="toggle">
                <input type="radio" name="request-kind" checked={kind === k} onChange={() => setKind(k)} />{" "}
                {REQUEST_KIND_LABEL[k]}
              </label>
            ))}
          </fieldset>
          {kind === "correction" ? (
            <label>
              경기 (내가 뛴 경기만)
              <select value={matchId} onChange={(e) => setMatchId(e.target.value)} aria-label="정정할 경기">
                <option value="">경기를 골라 주세요</option>
                {myMatches.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.matchNo}경기 · {formatDate(m.playedAt, tz)} · {STATE_LABEL[m.state]}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="hint">
              운영자가 확인하면 내 이름을 "탈퇴한 참가자"로 바꾸고 연결·기피 라인·신청을 지워요. 다른 사람의 전적이 깨지지 않게
              경기 기록(승패·라인)은 이름 없이 남아요. 되돌릴 수 없어요.
            </p>
          )}
          <label>
            {kind === "correction" ? "무엇이 틀렸나요?" : "남길 말 (선택)"}
            <textarea
              aria-label="요청 내용"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={kind === "correction" ? "예: 레드팀이 이겼어요" : ""}
            />
          </label>
          <p className={length > REQUEST_TEXT_MAX ? "hint warn" : "hint"}>
            {length} / {REQUEST_TEXT_MAX}자
          </p>
          <button
            type="submit"
            className="secondary"
            disabled={
              busy ||
              full ||
              length > REQUEST_TEXT_MAX ||
              (kind === "correction" && (matchId === "" || length === 0))
            }
          >
            {busy ? "보내는 중" : "요청 보내기"}
          </button>
          {full && <p className="hint">처리를 기다리는 요청이 {MAX_OPEN_REQUESTS}개라 더 남길 수 없어요.</p>}
        </form>
      </section>

      <section aria-label="내 요청">
        <h2>내 요청 {me.requests.length > 0 ? `${me.requests.length}개` : ""}</h2>
        {me.requests.length === 0 ? (
          <p className="hint">남긴 요청이 없어요.</p>
        ) : (
          <ul className="list" aria-label="내 요청 목록">
            {me.requests.map((r) => (
              <RequestRow key={r.id} request={r} matchNo={matchNoOf(r.matchId)} tz={tz} />
            ))}
          </ul>
        )}
      </section>

      <section aria-label="연결 끊기">
        <h2>연결 끊기</h2>
        <p className="hint">
          끊으면 이 계정으로 이 모임의 내 정보를 볼 수 없고, 기록은 그대로 남아요. 다시 연결하려면 운영자에게 새 연결 링크를 받아야
          해요.
        </p>
        <button type="button" className="danger" onClick={() => setUnlinkOpen(true)}>
          연결 끊기
        </button>
      </section>

      <p className="hint">
        {props.loadedAt ? `${formatTime(new Date(props.loadedAt).toISOString())} 확인` : ""}{" "}
        <button type="button" className="link" onClick={() => void props.reload()}>
          새로 고침
        </button>
      </p>
      {props.loadError && (
        <p className="note warn" role="alert">
          최신 상태를 불러오지 못했어요. 위는 마지막으로 받은 내용입니다.
        </p>
      )}

      {unlinkOpen && (
        <Dialog title="연결 끊기" onClose={() => setUnlinkOpen(false)}>
          <p>
            <strong>{myName}</strong> 님과 이 계정의 연결을 끊어요. 기록은 그대로 남아요.
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
                  await call("POST", `/api/member/${gid}/unlink`);
                  setUnlinkOpen(false);
                  props.onUnlinked();
                } catch (e) {
                  setError(e);
                  setBusy(false);
                }
              }}
            >
              연결 끊기
            </button>
            <button type="button" className="secondary" onClick={() => setUnlinkOpen(false)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** 요청 한 줄(멤버·운영자 화면 공통). 글은 React 글자로만 그린다(HTML로 해석하지 않음). */
export function RequestRow(props: {
  request: MemberRequestView;
  matchNo: number | undefined;
  tz: string;
  who?: string;
  children?: React.ReactNode;
}) {
  const r = props.request;
  return (
    <li className="list-row static request-row">
      <span className="name">
        {props.who && <strong>{props.who} · </strong>}
        {REQUEST_KIND_LABEL[r.kind]}
        {r.kind === "correction" && props.matchNo !== undefined && ` · ${props.matchNo}경기`}
        <span className={r.status === "open" ? "tag" : "tag muted"}>{REQUEST_STATUS_LABEL[r.status]}</span>
        <br />
        {r.text !== "" && <span className="request-text">{r.text}</span>}
        <br />
        <span className="hint">
          {formatDate(r.createdAt, props.tz)} {formatTime(r.createdAt, props.tz)}
        </span>
        {r.reply && (
          <>
            <br />
            <span className="hint">운영자 답: {r.reply}</span>
          </>
        )}
      </span>
      {props.children}
    </li>
  );
}

/**
 * 연결 링크를 연 화면(#/claim/토큰). 로그인한 뒤 확인하면 이 계정과 그 참가자가 묶인다.
 * 로그인하지 않았으면 로그인 창을 띄우고, 로그인하면 같은 주소라 이 화면으로 돌아온다.
 */
export function Claim(props: { token: string }) {
  const app = useAppValue();
  const [info, setInfo] = useState<{ groupName: string; participantName: string; expiresAt: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    call<{ groupName: string; participantName: string; expiresAt: string }>("GET", `/api/claim/${props.token}`)
      .then(setInfo)
      .catch((e) => {
        if (e instanceof ApiFailure && e.status === 404) setInvalid(true);
        else setError(e);
      });
  }, [props.token]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ groupId: string }>("POST", `/api/claim/${props.token}/accept`);
      await app.reloadMe();
      app.setNotice("연결했어요. 내 전적과 내 정보를 볼 수 있어요.");
      go(`/mine/${result.groupId}`);
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "CLAIM_INVALID") setInvalid(true);
      else setError(e);
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <h1>내 이름 연결</h1>
      {invalid ? (
        <p className="note warn" role="alert">
          이 연결 링크는 이미 썼거나 만료됐어요. 운영자에게 새 링크를 요청해 주세요.
        </p>
      ) : !info ? (
        <>
          {!error && <p>불러오는 중…</p>}
          <ErrorNote error={error} />
        </>
      ) : (
        <>
          <section className="card">
            <p>
              <strong>{info.groupName}</strong> 모임의 '<strong>{info.participantName}</strong>'을(를) 내 계정에 연결할까요?
            </p>
            <p className="hint">
              연결하면 로그인한 채로 내 전적을 바로 보고, 내 기피 라인을 정하고, 참가 신청을 본인 확인으로 하고, 기록 정정을 요청할
              수 있어요. 기록을 고치는 것은 운영자만 해요. 내 이름이 아니면 연결하지 말아 주세요.
            </p>
            <p className="hint">
              링크 만료: {formatDate(info.expiresAt)} {formatTime(info.expiresAt)}
            </p>
          </section>
          <ErrorNote error={error} />
          {app.me?.accountId ? (
            <button type="button" className="primary wide" disabled={busy} onClick={() => void accept()}>
              {busy ? "처리 중" : "내 계정에 연결"}
            </button>
          ) : (
            <button type="button" className="primary wide" onClick={() => setLoginOpen(true)}>
              로그인하고 계속
            </button>
          )}
        </>
      )}
      {loginOpen && (
        <LoginDialog
          reason="연결할 내 계정으로 로그인해 주세요. 로그인하면 이 화면으로 돌아와요."
          onClose={() => setLoginOpen(false)}
          onDone={() => setLoginOpen(false)}
        />
      )}
    </div>
  );
}
