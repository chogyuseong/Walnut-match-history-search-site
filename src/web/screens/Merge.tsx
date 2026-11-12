import { useRef, useState } from "react";
import { placementGamesOf } from "../../shared/stats";
import { titleBandsOf, titleGradeFor, type Standing } from "../../shared/titles";
import type { MatchState, ParticipantView } from "../../shared/types";
import { call, mutate, newRequestId } from "../api";
import { formatDate, formatTime, nameMap } from "../format";
import { Help, TitleBadge } from "../screenKit";
import { Dialog, ErrorNote } from "../ui";
import { go, useAppValue } from "../useApp";

/** 되돌리기 응답의 본인 연결 결과(src/server/merge.ts UndoLinkResult). */
interface UndoLink {
  outcome: "returned" | "not_returned" | "cut" | "unknown";
  avoidChanged: boolean;
}

/** 되돌리기 뒤 본인 연결 안내. 연결이 없었으면 빈 글. */
function undoLinkText(link: UndoLink | null | undefined, source: string, target: string): string {
  if (!link) return "";
  const parts = {
    returned: `본인 연결도 '${source}'에게 돌려놓았어요.`,
    not_returned: `본인 연결은 그 사이 끊기거나 바뀌어 돌려놓지 않았어요. 필요하면 '${source}'에게 연결 링크를 새로 보내 주세요.`,
    cut: `'${target}'에 남아 있던 '${source}'의 본인 연결을 끊었어요. 필요하면 연결 링크를 새로 보내 주세요.`,
    unknown: `예전에 한 합치기라 연결 기록이 없어요. '${target}'의 본인 연결이 맞는 사람인지 확인해 주세요.`,
  };
  const avoid = link.avoidChanged ? ` 합쳐져 있는 동안 본인이 '${target}'의 기피 라인을 바꿨어요. 확인해 주세요.` : "";
  return ` ${parts[link.outcome]}${avoid}`;
}

/** 서버의 합치기 미리보기 응답(src/server/merge.ts의 MergePreview). */
interface Preview {
  ok: boolean;
  problems: string[];
  source: { id: string; name: string; status: string };
  target: { id: string; name: string; status: string };
  movedMatches: number;
  /** 함께 옮겨지는 지운 경기 수(movedMatches에는 들지 않는다). */
  deletedMatches?: number;
  byState: Partial<Record<MatchState, number>>;
  overlaps: { matchId: string; matchNo: number }[];
  inProgress: { matchId: string; matchNo: number }[];
  rotation: { moved: number; converted: number };
  standings: { source: Standing | null; target: Standing | null; merged: Standing | null };
}

const STATE_TEXT: Record<MatchState, string> = {
  confirmed: "결과 확정",
  awaiting_result: "결과 입력 대기",
  excluded: "전적 제외",
  canceled: "미진행 취소",
  in_progress: "진행 중",
};

function placementText(s: Standing | null, placementGames: number): string {
  if (!s) return "기록 없음";
  return s.done ? "배치 완료" : `배치 ${s.games}/${placementGames}`;
}

/**
 * 중복 참가자 합치기(#/merge). 모임 탭의 참가자 목록에서 들어온다.
 * 고르기 → 서버가 계산한 미리보기(옮길 경기, 합친 뒤 승패·배치·칭호, 막는 이유) → 합치기.
 * 합친 기록은 아래 목록에서 되돌릴 수 있다.
 */
export function Merge() {
  const app = useAppValue();
  const snapshot = app.snapshot;
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  // 요청 ID는 미리보기를 받을 때 만들고, 응답을 못 받아 다시 누를 때는 같은 값을 쓴다.
  const requestId = useRef(newRequestId());
  const undoRequestId = useRef(newRequestId());

  if (!snapshot) {
    return (
      <div className="screen">
        <h1>중복 참가자 합치기</h1>
        <p>아직 모임이 없어요.</p>
        <button type="button" className="primary" onClick={() => go("/group")}>
          모임 탭으로
        </button>
      </div>
    );
  }
  const gid = snapshot.group.id;
  const tz = snapshot.group.timezone;
  const nameOf = nameMap(snapshot);
  const choosable = snapshot.participants
    .filter((p) => !p.mergedInto)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const label = (p: ParticipantView) => (p.status === "archived" ? `${p.name} (보관)` : p.name);

  function choose(nextSource: string, nextTarget: string) {
    setSourceId(nextSource);
    setTargetId(nextTarget);
    setPreview(null);
    setError(null);
  }

  async function loadPreview() {
    setBusy(true);
    setError(null);
    try {
      const result = await call<Preview>(
        "GET",
        `/api/groups/${gid}/merges/preview?source=${encodeURIComponent(sourceId)}&target=${encodeURIComponent(targetId)}`,
      );
      setPreview(result);
      requestId.current = newRequestId();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function runMerge() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutate<{ matchCount: number }>(`/api/groups/${gid}/merges`, {
        requestId: requestId.current,
        sourceId: preview.source.id,
        targetId: preview.target.id,
      });
      await app.refreshAfterOwnChange();
      app.setNotice(
        `'${preview.source.name}'을(를) '${preview.target.name}'에 합쳤어요. 경기 ${result.matchCount}개를 옮겼습니다.`,
      );
      choose("", "");
    } catch (e) {
      setError(e);
      void app.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function runUndo(mergeId: string, sourceName: string, targetName: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate<{ matchCount: number; link?: UndoLink | null }>(
        `/api/groups/${gid}/merges/${mergeId}/undo`,
        { requestId: undoRequestId.current },
      );
      await app.refreshAfterOwnChange();
      app.setNotice(
        `합치기를 되돌렸어요. 경기 ${result.matchCount}개를 원래 이름으로 돌렸습니다.` +
          undoLinkText(result.link, sourceName, targetName),
      );
      undoRequestId.current = newRequestId();
      setUndoing(null);
    } catch (e) {
      setError(e);
      void app.refresh();
    } finally {
      setBusy(false);
    }
  }

  const merges = snapshot.merges ?? [];
  const pendingUndo = merges.find((m) => m.id === undoing) ?? null;
  const linked = new Set((snapshot.memberLinks ?? []).map((l) => l.participantId));

  return (
    <div className="screen merge">
      <header className="screen-head">
        <button type="button" className="link" onClick={() => go("/group")}>
          ← 모임
        </button>
        <h1>중복 참가자 합치기</h1>
      </header>
      <p className="hint">
        같은 사람이 다른 이름으로 두 번 들어갔을 때 하나로 합칩니다. 없앨 이름의 모든 경기 기록과 서포터 횟수
        기록이 남길 이름으로 옮겨지고, 없앨 이름은 보관됩니다. 잘못 합쳤으면 아래 기록에서 되돌릴 수 있어요.
      </p>

      <section aria-label="합칠 두 이름 고르기" className="merge-pick">
        <label>
          없앨 이름
          <select
            className="merge-select"
            value={sourceId}
            disabled={busy}
            onChange={(e) => choose(e.target.value, targetId === e.target.value ? "" : targetId)}
          >
            <option value="">고르세요</option>
            {choosable.map((p) => (
              <option key={p.id} value={p.id}>
                {label(p)}
              </option>
            ))}
          </select>
        </label>
        <label>
          남길 이름
          <select
            className="merge-select"
            value={targetId}
            disabled={busy}
            onChange={(e) => choose(sourceId, e.target.value)}
          >
            <option value="">고르세요</option>
            {choosable
              .filter((p) => p.id !== sourceId)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {label(p)}
                </option>
              ))}
          </select>
        </label>
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={busy || sourceId === "" || targetId === "" || sourceId === targetId}
            onClick={() => void loadPreview()}
          >
            합치면 어떻게 되는지 보기
          </button>
        </div>
      </section>

      {!preview && <ErrorNote error={error} />}

      {preview && !preview.ok && (
        <div className="note error" role="alert">
          <p>
            <strong>이 두 이름은 합칠 수 없어요.</strong> 아무것도 바꾸지 않았습니다.
          </p>
          <ul className="problem-list">
            {preview.problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
          {preview.overlaps.length > 0 && (
            <p className="button-row">
              {preview.overlaps.map((m) => (
                <button key={m.matchId} type="button" className="link" onClick={() => go(`/m/${m.matchId}`)}>
                  {m.matchNo}경기 보기
                </button>
              ))}
            </p>
          )}
        </div>
      )}

      {preview?.ok && (
        <section aria-label="합치기 미리보기" className="merge-preview">
          <p>
            <strong>{preview.source.name}</strong> → <strong>{preview.target.name}</strong>
          </p>
          <p>
            옮겨질 경기 {preview.movedMatches}개
            {preview.movedMatches > 0 &&
              ` (${Object.entries(preview.byState)
                .map(([state, n]) => `${STATE_TEXT[state as MatchState]} ${n}`)
                .join(", ")})`}
            {(preview.deletedMatches ?? 0) > 0 && ` · 지운 경기 ${preview.deletedMatches}개도 함께 옮겨져요`}
            {preview.rotation.moved > 0 && ` · 서포터 횟수 기록 ${preview.rotation.moved}건`}
          </p>
          {preview.rotation.converted > 0 && (
            <p className="note" role="note">
              서포터 횟수를 초기화한 뒤 두 이름이 각각 서포터를 했어요. 한 사람이 두 번 한 것이므로 나중 기록{" "}
              {preview.rotation.converted}건을 반복 기록으로 바꿉니다. 합친 사람의 서포터 횟수는 두 이름의 합이에요.
            </p>
          )}
          <div className="table-scroll">
            <table className="restore-diff merge-table">
              <caption className="restore-caption">합치기 전후 누적 기록</caption>
              <thead>
                <tr>
                  <th scope="col">누적 기준</th>
                  <th scope="col">{preview.source.name}</th>
                  <th scope="col">{preview.target.name}</th>
                  <th scope="col">합친 뒤</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">승·패</th>
                  {[preview.standings.source, preview.standings.target, preview.standings.merged].map((s, i) => (
                    <td key={i}>{s ? `${s.wins}승 ${s.losses}패` : "-"}</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">배치</th>
                  {[preview.standings.source, preview.standings.target, preview.standings.merged].map((s, i) => (
                    <td key={i}>{placementText(s, placementGamesOf(snapshot.group.settings))}</td>
                  ))}
                </tr>
                <tr>
                  <th scope="row">칭호</th>
                  {[preview.standings.source, preview.standings.target, preview.standings.merged].map((s, i) => (
                    <td key={i}>
                      {s?.title && snapshot ? (
                        <TitleBadge
                          name={s.title}
                          grade={titleGradeFor(s.wins, s.games, titleBandsOf(snapshot.group.settings))}
                        />
                      ) : (
                        (s?.title ?? "없음")
                      )}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p className="hint">
            결과 확정 경기만 셉니다. 합친 뒤 '{preview.source.name}'은(는) 보관되어 참가자 고르기에 보이지 않고, 이
            기기의 작성 중 편성에 있던 '{preview.source.name}'은(는) '{preview.target.name}'(으)로 바뀝니다.
          </p>
          {linked.has(preview.source.id) && (
            <p className="note" role="note">
              {linked.has(preview.target.id)
                ? `'${preview.target.name}'에 이미 본인 연결이 있어 '${preview.source.name}'의 본인 연결은 끊겨요. 되돌리면 다시 이어져요.`
                : `'${preview.source.name}'의 본인 연결도 '${preview.target.name}'에게 옮겨지고, 되돌리면 함께 돌아와요.`}
            </p>
          )}
          <Help label="본인 연결은 어떻게 되나요">
            <p>
              연결이 옮겨지면 그 계정이 '{preview.target.name}'의 본인이 되어 기피 라인을 정하고 정정·삭제 요청을 남길 수
              있어요. 같은 사람일 때만 합쳐 주세요.
            </p>
            <p>
              되돌리면 연결과 합칠 때 함께 옮긴 요청이 원래 이름으로 돌아가요. 그 사이 연결이 끊기거나 다른 계정으로
              바뀌었으면 연결은 되돌리지 않아요(필요하면 연결 링크를 새로 보내요). 합쳐져 있는 동안 본인이 기피 라인을
              바꿨으면 되돌린 뒤 알려 드려요. 2026년 11월 8일 전에 한 합치기는 연결 기록이 없어 연결이 돌아가지 않아요.
            </p>
          </Help>
          <ErrorNote error={error} onCheck={() => void runMerge()} />
          <div className="button-row">
            <button type="button" className="primary" disabled={busy} onClick={() => void runMerge()}>
              합치기
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => choose("", "")}>
              그만두기
            </button>
          </div>
        </section>
      )}

      <section aria-label="합친 기록">
        <h2>합친 기록</h2>
        {merges.length === 0 ? (
          <p className="hint">아직 합친 적이 없어요.</p>
        ) : (
          <ul className="list">
            {merges.map((m) => (
              <li key={m.id} className="list-row static merge-row">
                <span>
                  {nameOf(m.sourceId)} → {nameOf(m.targetId)} · {m.matchCount}경기
                  <br />
                  <span className="hint">
                    {formatDate(m.createdAt, tz)} {formatTime(m.createdAt, tz)}
                    {m.undoneAt && ` · ${formatDate(m.undoneAt, tz)} 되돌림`}
                  </span>
                </span>
                {!m.undoneAt && (
                  <button type="button" className="secondary" disabled={busy} onClick={() => setUndoing(m.id)}>
                    되돌리기
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {pendingUndo && (
        <Dialog title="합치기 되돌리기" onClose={() => setUndoing(null)}>
          <p>
            '{nameOf(pendingUndo.sourceId)}'의 경기 기록을 원래 이름으로 돌려놓고 보관을 풉니다. 합친 뒤 '
            {nameOf(pendingUndo.targetId)}'(으)로 새로 저장한 경기는 그대로 둡니다. 옮겨진 본인 연결도 원래 이름으로 돌려놓아요.
          </p>
          <ErrorNote
            error={error}
            onCheck={() => void runUndo(pendingUndo.id, nameOf(pendingUndo.sourceId), nameOf(pendingUndo.targetId))}
          />
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void runUndo(pendingUndo.id, nameOf(pendingUndo.sourceId), nameOf(pendingUndo.targetId))}
            >
              되돌리기
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setUndoing(null)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
