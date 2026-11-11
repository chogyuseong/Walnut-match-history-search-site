import { useCallback, useEffect, useRef, useState } from "react";
import {
  dayRecordOf,
  liveDataOf,
  nextPollDelay,
  rosterChanges,
  seatOf,
  type LiveData,
} from "../../shared/liveView";
import { TEAMS, type MatchView, type Snapshot, type Team } from "../../shared/types";
import { ApiFailure, getWithEtag } from "../api";
import {
  formatDate,
  formatTime,
  POSITION_LABEL,
  resultLine,
  TEAM_MARK,
  teamBoxClass,
  teamName,
  teamRoster,
} from "../format";
import { PosLabel, ScreenHead } from "../screenKit";
import { LineIcon } from "../ui";

/**
 * 참가자에게 보내는 편성 화면(#/v/토큰/live, 2026-11-07). 로그인 없이 조회 토큰으로 연다.
 * 보여 주는 것: 진행 중 경기의 블루·레드 10명과 포지션, 시작 시각. 진행 중 경기가 없으면 최근 경기 1개.
 * 보여 주지 않는 것: 티어·서포터 횟수·기피 라인(조회 응답에도 없고, 티어를 공개한 모임이어도 이 화면은 그리지 않는다).
 * 휴대폰에서 링크를 열자마자 보이도록 조회 화면(Viewer.tsx, 기록·통계 화면을 함께 씀)과 따로 작은 묶음으로 받는다
 * (src/web/lazyScreens.ts의 공개 화면).
 *
 * 2026-11-10 실험 B-1(docs/개선-경험-설계-2026-11-10.md 5·6절): 명단 줄을 눌러 내 이름 고르기, 맨 위 내 자리 요약,
 * 바뀐 자리 안내, 상태별 간격으로 확인하다 실패가 이어지면 멈추기, 링크가 폐기되면(404) 명단을 지우고 끝내기.
 * 폐기 조건은 설계 문서 5절. 되돌릴 때는 이 파일과 src/shared/liveView.ts만 이전으로 돌리면 된다(서버·API는 그대로다).
 * "내 이름"은 이 기기의 표시일 뿐이라 어떤 요청에도 싣지 않는다.
 */
export function ViewerLive(props: { token: string }) {
  const { token } = props;
  const meKey = `naejeon.me.${token}`;
  const { snapshot, status, note, checkNow } = useLiveSnapshot(token);
  const [myId, setMyId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(meKey);
    } catch {
      return null;
    }
  });

  const choose = (id: string | null) => {
    setMyId(id);
    try {
      if (id) localStorage.setItem(meKey, id);
      else localStorage.removeItem(meKey);
    } catch {
      // 보관하지 못하면 이번 방문에만 적용된다.
    }
  };

  if (status.gone) {
    return (
      <div className="screen">
        <h1>링크를 열 수 없어요</h1>
        <p className="note warn" role="alert">
          이 링크는 더 이상 열리지 않아요. 운영자에게 새 링크를 받아 주세요.
        </p>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="screen">
        {status.failures > 0 ? (
          <p className="note warn" role="alert">
            불러오지 못했어요.{" "}
            <button type="button" className="link" onClick={checkNow}>
              다시 불러오기
            </button>
          </p>
        ) : (
          <p>불러오는 중…</p>
        )}
      </div>
    );
  }

  const data = liveDataOf(snapshot);
  const tz = data.timeZone;
  const match = data.shown;
  const live = match?.state === "in_progress" ? match : null;
  const meId = myId ? data.resolve(myId) : null;
  const stale = status.failures > 0 || status.stopped;
  const okTime = status.at ? formatTime(new Date(status.at).toISOString(), tz) : "";
  // 바뀜 꼬리표는 지금 보이는 경기의 변화일 때만 단다(다음 경기가 올라오면 지난 표시는 의미가 없다).
  const changed = note && match && note.matchId === match.id ? note.changedIds : null;

  return (
    <>
      <nav className="viewer-nav" aria-label="조회 메뉴">
        <strong>{data.groupName}</strong>
        <span>
          <a className="link" href={`#/v/${token}/now`}>
            <LineIcon name="records" />
            기록 보기
          </a>{" "}
          <a className="link" href={`#/v/${token}/ranking`}>
            <LineIcon name="ranking" />
            랭킹
          </a>
        </span>
      </nav>
      {data.maintenance && (
        <p className="note warn viewer-note" role="status">
          운영자가 모임 기록을 점검하는 중이에요. 잠시 뒤 새로 고쳐 주세요.
        </p>
      )}
      <div className="screen live-roster">
        <ScreenHead
          title={live ? `${live.matchNo}경기 편성` : "편성"}
          badge={
            live &&
            (stale ? (
              <span className="badge warn-badge">{okTime} 기준</span>
            ) : (
              <span className="badge ok">진행 중 · {formatTime(live.startedAt, tz)} 시작</span>
            ))
          }
        />
        {/* 안내는 지금 진행 중인 그 경기의 것만 보인다. 경기가 끝나면 "N경기 편성이 올라왔어요"가 "진행 중 경기 없음"과 같이 남지 않게. */}
        {note && live && note.matchId === live.id && (
          <p className="note" role="status">
            {note.text}
          </p>
        )}
        {!live && (
          <p className="note" role="status">
            지금 진행 중인 경기가 없어요.
            {data.sessionOpen && " 다음 경기는 운영자가 시작하면 여기에 떠요."}
          </p>
        )}

        {match && (
          <MySeat data={data} match={match} meId={meId} onChange={() => choose(null)} />
        )}

        {match &&
          (live ? (
            <LiveTeams match={match} data={data} meId={meId} changed={changed} onPick={meId ? null : choose} />
          ) : (
            <section aria-label="최근 경기">
              <h2>
                최근 경기 · {match.matchNo}경기 · {resultLine(match)}
              </h2>
              <p className="hint">
                {formatDate(match.playedAt, tz)} {formatTime(match.playedAt, tz)}
              </p>
              <LiveTeams match={match} data={data} meId={meId} changed={changed} onPick={meId ? null : choose} />
            </section>
          ))}

        <p className={stale ? "note warn live-check" : "hint live-check"} role={stale ? "alert" : undefined}>
          {status.stopped
            ? `자동 확인을 멈췄어요. ${okTime} 내용이에요. `
            : status.failures > 0
              ? `연결이 끊겼어요. ${okTime} 내용이에요. `
              : `${okTime} 확인 · 자동으로 확인하고 있어요. `}
          <button type="button" className="link" onClick={checkNow}>
            지금 확인
          </button>
        </p>
      </div>
    </>
  );
}

/**
 * 맨 위 "내 자리". 이름을 안 골랐으면 고르는 방법만, 골랐으면 팀·라인·같은 팀·맞라인.
 * 진행 중 경기가 없으면 최근 경기의 내 결과와 그 내전 성적(확정 경기만)을 쓴다.
 */
function MySeat(props: { data: LiveData; match: MatchView; meId: string | null; onChange: () => void }) {
  const { data, match, meId } = props;
  const change = (
    <button type="button" className="link" onClick={props.onChange}>
      이름 바꾸기
    </button>
  );
  if (!meId) {
    return (
      <section className="card live-me" aria-label="내 자리">
        <p className="hint">
          아래 명단에서 내 이름을 누르면 내 자리를 먼저 보여드려요. 이 기기에서만 쓰는 표시이고 로그인이 아니에요.
        </p>
      </section>
    );
  }
  const name = data.nameOf(meId);
  const seat = seatOf(match, meId);
  const live = match.state === "in_progress";
  const side = (team: Team) => teamName(team, match.teamASide);
  return (
    <section className="card live-me" aria-label="내 자리">
      {!seat ? (
        <p>
          {name} 님은 {match.matchNo}경기 명단에 없어요.
        </p>
      ) : live ? (
        <>
          <p className="live-me-head">
            <strong>{side(seat.team)}</strong>
            {seat.position && <> · {POSITION_LABEL[seat.position]}</>} · {name}
            <span className="tag tag-me">나</span>
          </p>
          <p>
            <span className="live-me-label">같은 팀</span>{" "}
            {seat.teammates.map((r) => data.nameOf(r.participantId)).join(" · ")}
          </p>
          {seat.opponent && (
            <p>
              <span className="live-me-label">맞라인</span> {data.nameOf(seat.opponent.participantId)}
            </p>
          )}
        </>
      ) : (
        <p className="live-me-head">
          <strong>
            {match.matchNo}경기 {resultLine(match)}
          </strong>
          {match.state === "confirmed" && match.winnerTeam && (
            <> · {match.winnerTeam === seat.team ? "내 팀 승리" : "내 팀 패배"}</>
          )}
        </p>
      )}
      {!live && <DayRecord data={data} meId={meId} />}
      <p>{change}</p>
    </section>
  );
}

/** "11월 10일 내전 2승 1패(확정 3경기, 결과 안 들어온 1경기 제외)". 그 내전에서 뛴 확정 경기가 없으면 그리지 않는다. */
function DayRecord(props: { data: LiveData; meId: string }) {
  const { data, meId } = props;
  const record = dayRecordOf(data.matches, meId);
  const decided = record.wins + record.losses;
  if (decided === 0 && record.pending === 0) return null;
  const first = data.matches.reduce<MatchView | null>((a, m) => (!a || m.playedAt < a.playedAt ? m : a), null);
  return (
    <p>
      {formatDate(first?.playedAt, data.timeZone)} 내전 {record.wins}승 {record.losses}패(확정 {decided}경기
      {record.pending > 0 && `, 결과 안 들어온 ${record.pending}경기 제외`})
    </p>
  );
}

/**
 * 블루·레드 명단. screenKit.tsx의 MatchTeams와 같은 모양(.teams/.team/.row)이지만 줄을 눌러 "내 이름"을 고르고
 * "나"·"바뀜" 글자 꼬리표를 단다. 여러 화면이 함께 받는 부품 묶음(screenKit.tsx)을 키우지 않으려고 이 화면 안에 둔다.
 */
function LiveTeams(props: {
  match: MatchView;
  data: LiveData;
  meId: string | null;
  changed: ReadonlySet<string> | null;
  onPick: ((id: string) => void) | null;
}) {
  const { match, data, meId, changed, onPick } = props;
  return (
    <div className="teams">
      {TEAMS.map((team) => (
        <section key={team} className={teamBoxClass(team, match.teamASide)} aria-label={teamName(team, match.teamASide)}>
          <h3>
            <span aria-hidden="true">{TEAM_MARK[team]}</span> {teamName(team, match.teamASide)}
          </h3>
          <ul>
            {teamRoster(match, team).map((entry) => {
              const id = entry.participantId;
              const name = data.nameOf(id);
              const tags = (
                <>
                  {id === meId && <span className="tag tag-me">나</span>}
                  {changed?.has(id) && <span className="tag tag-changed">바뀜</span>}
                </>
              );
              return onPick ? (
                <li key={id}>
                  <button type="button" className="row live-pick" onClick={() => onPick(id)}>
                    <PosLabel position={entry.position} />
                    <span className="name">{name}</span>
                    {tags}
                    <span className="sr-only"> 내 이름으로 고르기</span>
                  </button>
                </li>
              ) : (
                <li key={id} className={id === meId ? "row me" : "row"}>
                  <PosLabel position={entry.position} />
                  <span className="name" title={name}>
                    {name}
                  </span>
                  {tags}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

interface ChangeNote {
  matchId: string;
  text: string;
  /** 새로 들어온 사람(바뀜 꼬리표). */
  changedIds: ReadonlySet<string>;
}

/** 화면을 열어 둔 동안의 변화 한 줄. 처음 받은 내용과 바뀐 것이 없으면 null. */
function changeNoteOf(prev: Snapshot | null, next: Snapshot): ChangeNote | null {
  if (!prev) return null;
  const before = liveDataOf(prev).shown;
  const after = liveDataOf(next);
  const shown = after.shown;
  if (!shown) return null;
  if (before && before.id === shown.id) {
    const changes = rosterChanges(before, shown);
    if (changes.length === 0) return null;
    const seat = (c: (typeof changes)[number]) =>
      `${teamName(c.team, shown.teamASide).replace(/팀$/, "")}${c.position ? ` ${POSITION_LABEL[c.position]}` : ""}`;
    return {
      matchId: shown.id,
      text: `바뀐 자리: ${changes.map((c) => `${seat(c)} ${after.nameOf(c.outId)} → ${after.nameOf(c.inId)}`).join(", ")}`,
      changedIds: new Set(changes.map((c) => c.inId)),
    };
  }
  if (shown.state === "in_progress") {
    return { matchId: shown.id, text: `${shown.matchNo}경기 편성이 올라왔어요.`, changedIds: new Set() };
  }
  return null;
}

interface LiveStatus {
  /** 마지막으로 응답을 받은 시각(ms). */
  at: number | null;
  failures: number;
  /** 자동 확인을 멈췄는지(실패가 이어짐, 또는 오래 바뀐 것이 없음). "지금 확인"으로 다시 시작한다. */
  stopped: boolean;
  /** 링크가 폐기됨(404). 다시 확인하지 않는다. */
  gone: boolean;
}

/**
 * 조회 응답을 상태별 간격으로 다시 확인한다(간격 규칙은 shared/liveView.ts nextPollDelay).
 * 타이머는 setTimeout 한 줄기뿐이고, 겹친 요청은 순번으로 마지막 것만 반영한다. 화면이 숨으면 타이머를 지우고
 * 다시 보이면(visibilitychange·pageshow·online) 한 번 확인한다. ETag가 같으면 이전 객체를 그대로 둔다(다시 그리지 않음).
 */
function useLiveSnapshot(token: string) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [note, setNote] = useState<ChangeNote | null>(null);
  const [status, setStatus] = useState<LiveStatus>({ at: null, failures: 0, stopped: false, gone: false });
  const checkRef = useRef<(manual: boolean) => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seq = 0;
    let etag: string | null = null;
    let current: Snapshot | null = null;
    let at: number | null = null;
    let failures = 0;
    let retryAfterMs: number | undefined;
    let changedAt = Date.now();
    let stopped = false;
    let gone = false;

    const publish = () => setStatus({ at, failures, stopped, gone });
    const clear = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const schedule = () => {
      clear();
      if (disposed || gone || stopped || document.visibilityState === "hidden") return;
      // 아직 한 번도 못 받았으면 대기 간격으로 다시 시도한다. "idle"(120초)에 실패 배수가 붙으면 첫 실패 뒤 4분 가까이 빈 화면이다.
      const phase = current ? liveDataOf(current).phase : "waiting";
      const delay = nextPollDelay({ phase, failures, quietMs: Date.now() - changedAt, retryAfterMs }, Math.random);
      if (delay === null) {
        stopped = true;
        publish();
        return;
      }
      timer = setTimeout(() => void check(), delay);
    };
    const check = async () => {
      clear();
      const mine = ++seq;
      try {
        const res = await getWithEtag<Snapshot>(`/api/view/${token}`);
        if (disposed || mine !== seq) return;
        at = Date.now();
        failures = 0;
        retryAfterMs = undefined;
        if (res.etag === null || res.etag !== etag) {
          etag = res.etag;
          const next = changeNoteOf(current, res.data);
          if (next) setNote(next);
          current = res.data;
          changedAt = at;
          setSnapshot(res.data);
        }
      } catch (e) {
        if (disposed || mine !== seq) return;
        if (e instanceof ApiFailure && e.status === 404) {
          gone = true;
          current = null;
          setSnapshot(null);
          setNote(null);
          clear();
          publish();
          return;
        }
        failures += 1;
        const retryAfter = e instanceof ApiFailure && e.status === 429 ? Number(e.details?.retryAfter) : NaN;
        retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
      }
      publish();
      schedule();
    };
    // "지금 확인"과 화면 복귀: 멈춘 확인을 다시 시작한다. 실패 수를 지워 처음부터 5번을 센다.
    const restart = (manual: boolean) => {
      if (gone) return;
      if (manual) changedAt = Date.now();
      stopped = false;
      failures = 0;
      retryAfterMs = undefined;
      void check();
    };
    checkRef.current = restart;

    const onVisible = () => {
      if (document.visibilityState === "hidden") clear();
      else restart(false);
    };
    const onHide = () => clear();
    // pageshow는 뒤로 가기 캐시에서 돌아올 때만(처음 열 때는 아래 첫 확인이 있다).
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) restart(false);
    };
    const onOnline = () => restart(false);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    window.addEventListener("online", onOnline);
    void check();
    return () => {
      disposed = true;
      clear();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("online", onOnline);
    };
  }, [token]);

  const checkNow = useCallback(() => checkRef.current(true), []);
  return { snapshot, status, note, checkNow };
}
