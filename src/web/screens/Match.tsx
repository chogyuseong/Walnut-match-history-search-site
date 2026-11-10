import { useEffect, useRef, useState } from "react";
import { avoidMapFor } from "../../shared/avoid";
import { draftFromMatch } from "../../shared/draft";
import { nextLineup, planNextDraft, sessionMatchesOf } from "../../shared/nightPool";
import { TEAM_SIZE_TOTAL } from "../../shared/prepTools";
import { matchesName } from "../../shared/search";
import type { MatchView, Snapshot } from "../../shared/types";
import { ApiFailure, mutate, newRequestId } from "../api";
import { formatTime, matchRosterText, nameMap, POSITION_LABEL, teamName, viewLink } from "../format";
import { BackLink, MatchTeams, StickyAction } from "../screenKit";
import { CopyButton, Dialog, ErrorNote } from "../ui";
import { liveNightPool, readCarry, writeNightPool } from "../nightPoolStore";
import { go, useAppValue, type AppValue } from "../useApp";
import { ResultSheet } from "./ResultSheet";

/**
 * 다음 판 준비(후보 A): 초안이 없으면 같은 팀으로 만들고, 있으면 그 초안을 연다.
 * series가 true면 "시리즈로 이어가기"를 골라 둔다(직전 경기가 시리즈에 없으면 3판 2선승으로 새로 만든다. 준비 화면에서 바꿀 수 있다).
 * 오늘 명단이 있으면(11명 이상 온 밤) 쉬던 사람을 넣은 초안을 만든다(src/shared/nightPool.ts). 시리즈는 같은 10명이 이어서 하는
 * 판이라 바꾸지 않고 쉬는 사람만 붙인다. 지난 경기의 팀 조건은 두 사람이 모두 새 초안에 있으면 이어 온다.
 */
export function prepareNext(app: AppValue, from: MatchView, options: { series?: boolean } = {}): void {
  const series = options.series ? { format: "bo3" as const, name: "" } : null;
  if (app.draft && app.draft.sourceMatchId === from.id && options.series) {
    // 같은 경기에서 이미 만든 초안: 이어가기만 켠다.
    app.setDraft({ ...app.draft, series: app.draft.series ?? series });
  }
  if (!app.draft && app.snapshot) {
    const snapshot = app.snapshot;
    const nameOf = nameMap(snapshot);
    const base = draftFromMatch(from, nameOf, {
      groupId: snapshot.group.id,
      baseLiveVersion: snapshot.group.liveVersion,
      seed: (Math.random() * 0xffffffff) >>> 0,
      now: new Date().toISOString(),
      // 같은 팀으로 포지션을 새로 뽑을 때도 기피 라인을 되도록 피한다.
      avoid: avoidMapFor(
        from.roster.map((r) => ({ key: `p:${r.participantId}`, participantId: r.participantId })),
        snapshot.participants,
      ),
    });
    const night = liveNightPool(snapshot);
    if (night?.changed) writeNightPool(night.pool);
    const draft = planNextDraft({ ...base, sourceMatchId: from.id, series }, from, {
      pool: night?.pool ?? null,
      added: night?.added ?? [],
      matches: snapshot.matches,
      carried: readCarry(snapshot.group.id),
      series: series !== null,
    });
    app.setDraft(draft);
  }
  go("/prep");
}

/**
 * 결과 저장 창의 "다음 판 쉬는 사람(제안)" 이름. 오늘 명단이 11명 이상일 때만 있다.
 * 운영자가 이 줄을 소리 내 읽거나 단톡에 옮기는 순간을 노린 것이라, "다음 경기 준비"가 만들 초안과 같은 규칙으로 센다.
 */
function nextRestNames(snapshot: Snapshot | null, saved: MatchView): string[] {
  const night = liveNightPool(snapshot);
  if (!snapshot || !night || night.pool.people.length <= TEAM_SIZE_TOTAL) return [];
  const matches = snapshot.matches.map((m) => (m.id === saved.id ? saved : m));
  const lineup = nextLineup(night.pool, saved, sessionMatchesOf(night.pool, matches));
  return lineup.outKeys.map((key) => night.pool.people.find((p) => p.key === key)?.name ?? "");
}

/** 화면 4 — 진행 중 경기. 주요 행동은 "결과 입력" 하나다. */
export function Match() {
  const app = useAppValue();
  // 결과를 저장하면 그 경기는 더 이상 "진행 중"이 아니므로, 창에 띄운 경기를 따로 붙잡아 둔다.
  const [sheetMatch, setSheetMatch] = useState<MatchView | null>(null);
  const [sharing, setSharing] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [cancelAsk, setCancelAsk] = useState<null | { needsDecision: boolean }>(null);
  const [sendOpen, setSendOpen] = useState(false);
  // 교체할 사람(진행 중 명단에서 누른 사람)의 참가자 ID.
  const [replacing, setReplacing] = useState<string | null>(null);
  const requestId = useRef<string | null>(null);

  // 진행 중 화면에서는 긴 주기로 최신 상태를 확인한다.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void app.refresh();
    }, 60000);
    return () => clearInterval(timer);
  }, [app.refresh]);

  const snapshot = app.snapshot;
  const match = snapshot?.matches.find((m) => m.state === "in_progress") ?? null;

  const nameOf = nameMap(snapshot);

  // key를 고정해 둔다. 저장 뒤 화면이 "진행 중 경기 없음"으로 바뀌어도
  // 같은 창이 유지돼 "저장됨" 표시와 다음 행동이 사라지지 않는다.
  const sheet = sheetMatch && (
    <ResultSheet
      key="result-sheet"
      match={sheetMatch}
      mode="result"
      nameOf={nameOf}
      onClose={() => {
        setSheetMatch(null);
        // 저장을 마쳤으면 진행 중 경기가 없으므로 홈으로 돌아간다.
        if (!match) go("/");
      }}
      afterSave={(saved) => {
        const resting = nextRestNames(app.snapshot, saved);
        return (
          <>
            {resting.length > 0 && <p className="hint">다음 판 쉬는 사람(제안): {resting.join(" · ")}</p>}
            <div className="button-row">
              <button type="button" className="primary" onClick={() => prepareNext(app, saved)}>
                다음 경기 준비
              </button>
              <button type="button" className="secondary" onClick={() => prepareNext(app, saved, { series: true })}>
                시리즈로 이어가기
              </button>
              <button type="button" className="link" onClick={() => go("/records")}>
                기록 보기
              </button>
              <button type="button" className="link" onClick={() => go(`/m/${saved.id}`)}>
                수정
              </button>
            </div>
          </>
        );
      }}
    />
  );

  if (!snapshot || !match) {
    return (
      <div className="screen">
        <header className="screen-head">
          <BackLink label="← 오늘" fallback={() => go("/")} />
          <h1>현재 경기</h1>
        </header>
        {!sheetMatch && (
          <>
            <p>진행 중인 경기가 없어요.</p>
            <button type="button" className="primary" onClick={() => go("/")}>
              오늘로 가기
            </button>
          </>
        )}
        {sheet}
      </div>
    );
  }

  async function run(action: "end-later" | "cancel", extra: Record<string, unknown> = {}) {
    if (!requestId.current) requestId.current = newRequestId();
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${snapshot!.group.id}/matches/${match!.id}/${action}`, {
        requestId: requestId.current,
        baseMatchVersion: match!.version,
        ...extra,
      });
      requestId.current = null;
      setCancelAsk(null);
      await app.refreshAfterOwnChange();
      go("/");
    } catch (e) {
      requestId.current = null;
      if (e instanceof ApiFailure && e.code === "ROTATION_DECISION_REQUIRED") {
        setCancelAsk({ needsDecision: true });
      } else {
        setError(e);
        void app.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="link" onClick={() => go("/")}>
          ← 오늘
        </button>
        <h1>{match.matchNo}경기 진행 중</h1>
        <span className="badge ok">
          저장됨 · {formatTime(match.startedAt, snapshot.group.timezone)} 시작
        </span>
      </header>

      <MatchTeams match={match} nameOf={nameOf} onPick={(id) => setReplacing(id)} />
      <p className="hint">사람을 누르면 다른 사람으로 바꿀 수 있어요(팀·포지션은 그대로).</p>

      <div className="button-row">
        <button type="button" className="secondary" onClick={() => setSendOpen(true)}>
          참가자에게 편성 보내기
        </button>
        <button type="button" className="secondary" onClick={() => setSharing(true)}>
          명단 공유
        </button>
        <button type="button" className="secondary" onClick={() => prepareNext(app, match)}>
          {app.draft ? "다음 초안 열기" : "다음 경기 준비"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => void run("end-later")}
        >
          결과는 나중에
        </button>
        <button type="button" className="link" onClick={() => setMore(!more)} aria-expanded={more}>
          ⋯ 더보기
        </button>
      </div>
      {more && (
        <div className="button-row">
          <button type="button" className="danger" onClick={() => setCancelAsk({ needsDecision: false })}>
            미진행 취소
          </button>
          <span className="hint">경기를 하지 않았을 때만 씁니다. 이 경기는 서포터 횟수에서 빠집니다.</span>
        </div>
      )}
      <ErrorNote error={error} />

      <StickyAction>
        <button type="button" className="primary wide" onClick={() => setSheetMatch(match)}>
          결과 입력
        </button>
      </StickyAction>

      {sheet}

      {sharing && snapshot.group.viewToken && (
        <Dialog title="명단 공유" onClose={() => setSharing(false)}>
          <p className="hint">
            링크는 항상 최신 상태를 보여줍니다. 텍스트는 복사한 시점의 내용입니다.
          </p>
          <div className="button-row">
            <CopyButton label="링크 복사" text={() => viewLink(snapshot.group.viewToken!)} />
            <CopyButton
              label="텍스트 복사"
              text={() => matchRosterText(snapshot, match, viewLink(snapshot.group.viewToken!))}
            />
          </div>
        </Dialog>
      )}

      {sendOpen && (
        <Dialog title="참가자에게 편성 보내기" onClose={() => setSendOpen(false)}>
          {snapshot.group.viewToken ? (
            <>
              <p>
                링크를 단톡방에 붙여 넣으면 참가자가 로그인 없이 휴대폰으로 블루·레드 10명과 포지션, 시작 시각을 봐요.
                티어·서포터 횟수는 보이지 않아요.
              </p>
              <p className="hint">링크는 항상 지금 진행 중인 경기를 보여 줘요(사람을 바꾸면 그대로 반영돼요).</p>
              <p className="hint">한 번 보내 두면 다음 경기도 같은 링크예요.</p>
              <div className="button-row">
                <CopyButton label="편성 링크 복사" text={() => viewLink(snapshot.group.viewToken!, "live")} />
              </div>
            </>
          ) : (
            <p className="note" role="status">
              모임 탭에서 조회 링크를 먼저 만들어요. 그 링크로 참가자 편성 화면이 열려요.
            </p>
          )}
        </Dialog>
      )}

      {replacing && (
        <ReplaceDialog
          key={replacing}
          match={match}
          outId={replacing}
          onClose={() => setReplacing(null)}
        />
      )}

      {cancelAsk && (
        <Dialog title="미진행 취소" onClose={() => setCancelAsk(null)}>
          {cancelAsk.needsDecision ? (
            <>
              <p>
                이 경기의 서포터가 뒤 경기에서도 서포터를 했어요. 뒤 경기 기록을 첫 번째 기록으로
                바꿀까요? 서포터 횟수는 어느 쪽이든 같아요.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void run("cancel", { convertRepeats: true })}
                >
                  바꾸고 취소
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void run("cancel", { convertRepeats: false })}
                >
                  그대로 두고 취소
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                {match.matchNo}경기를 하지 않은 것으로 처리합니다. 전적에 남지 않고 이 경기는 서포터
                횟수에서 빠집니다.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void run("cancel")}
                >
                  {busy ? "저장 중" : "미진행 취소"}
                </button>
                <button type="button" className="secondary" onClick={() => setCancelAsk(null)}>
                  돌아가기
                </button>
              </div>
            </>
          )}
          <ErrorNote error={error} />
        </Dialog>
      )}
    </div>
  );
}

/**
 * 진행 중 경기에서 한 사람을 같은 모임의 다른 활성 참가자로 바꾸는 창(PATCH /api/groups/:gid/matches/:mid/roster).
 * 들어오는 사람은 나간 사람의 팀·포지션을 물려받는다. 서포터 자리면 서포터 차례 기록도 서버가 함께 옮긴다.
 * 들어오는 사람이 이번 순환에서 이미 서포터를 했으면(SUPPORT_REPEAT) 한 번 더 묻고 확인을 실어 다시 보낸다.
 */
function ReplaceDialog(props: { match: MatchView; outId: string; onClose: () => void }) {
  const app = useAppValue();
  const snapshot = app.snapshot!;
  const nameOf = nameMap(snapshot);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [repeatAsk, setRepeatAsk] = useState<string | null>(null);
  // 요청 ID는 같은 내용(나가는 사람·들어오는 사람·확인)이면 재시도에 같은 값을 쓴다.
  const request = useRef<{ id: string; key: string } | null>(null);
  const seat = props.match.roster.find((r) => r.participantId === props.outId);
  const inRoster = new Set(props.match.roster.map((r) => r.participantId));
  // 공백·대소문자를 무시하고 초성("ㄱㅅ")으로도 찾는다(전적 검색과 같은 규칙).
  const candidates = snapshot.participants
    .filter((p) => p.status === "active" && !p.mergedInto && !inRoster.has(p.id))
    .filter((p) => matchesName(p.name, query))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));

  async function replace(inId: string, ackRepeat: boolean) {
    const key = `${props.outId}:${inId}:${ackRepeat}`;
    if (!request.current || request.current.key !== key) request.current = { id: newRequestId(), key };
    setBusy(true);
    setError(null);
    try {
      await mutate(
        `/api/groups/${snapshot.group.id}/matches/${props.match.id}/roster`,
        {
          requestId: request.current.id,
          baseMatchVersion: props.match.version,
          outParticipantId: props.outId,
          inParticipantId: inId,
          ...(ackRepeat ? { ackRepeat: true } : {}),
        },
        "PATCH",
      );
      request.current = null;
      await app.refreshAfterOwnChange();
      app.setNotice(`${nameOf(props.outId)} 자리에 ${nameOf(inId)} 님이 들어갔어요.`);
      props.onClose();
    } catch (e) {
      if (!(e instanceof ApiFailure) || e.kind !== "unknown") request.current = null;
      if (e instanceof ApiFailure && e.code === "SUPPORT_REPEAT") {
        setRepeatAsk(inId);
      } else {
        setError(e);
        void app.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  if (!seat) return null;
  const seatText = `${teamName(seat.team, props.match.teamASide)} ${seat.position ? POSITION_LABEL[seat.position] : ""}`.trim();

  return (
    <Dialog title="다른 사람으로 교체" onClose={props.onClose}>
      <p>
        <strong>{nameOf(props.outId)}</strong> 님 자리({seatText})에 들어갈 사람을 고르세요. 팀과 포지션은 그대로예요.
      </p>
      {seat.position === "support" && (
        <p className="hint">서포터 자리예요. 이 경기의 서포터 차례 기록도 들어오는 사람에게 옮겨요.</p>
      )}
      {repeatAsk ? (
        <div className="note warn" role="alert">
          <p>
            {nameOf(repeatAsk)} 님은 이번 순환에서 이미 서포터를 했어요. 그래도 서포터 자리에 넣을까요? 서포터 횟수가 한
            번 더 늘어요.
          </p>
          <div className="button-row">
            <button type="button" className="primary" disabled={busy} onClick={() => void replace(repeatAsk, true)}>
              {busy ? "저장 중" : "그래도 교체"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setRepeatAsk(null)}>
              다른 사람 고르기
            </button>
          </div>
        </div>
      ) : (
        <>
          <label>
            이름 찾기
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
          </label>
          {candidates.length === 0 ? (
            <p className="hint">
              {query.trim() === "" ? "바꿀 수 있는 다른 참가자가 없어요. 모임 탭에서 참가자를 먼저 넣어 주세요." : "일치하는 이름이 없어요."}
            </p>
          ) : (
            <ul className="list" aria-label="들어갈 사람">
              {candidates.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="list-row"
                    disabled={busy}
                    onClick={() => void replace(p.id, false)}
                  >
                    <span className="name">{p.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <ErrorNote error={error} onCheck={() => void app.refresh()} />
    </Dialog>
  );
}
