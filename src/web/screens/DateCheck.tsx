import { useMemo, useRef, useState } from "react";
import { FUTURE_TOLERANCE_MS } from "../../shared/backfill";
import { dateFindings, shiftYears, type YearRun } from "../../shared/dateCheck";
import type { MatchView } from "../../shared/types";
import { mutate, newRequestId } from "../api";
import { localDate } from "../../shared/stats";
import { formatTime } from "../format";
import { BackLink, Help } from "../screenKit";
import { Dialog, ErrorNote } from "../ui";
import { go, useAppValue } from "../useApp";

/**
 * 날짜 점검(#/dates, 2026-11-08). 저장된 확정 경기에서 날짜·연도가 맥락상 틀린 것을 찾아 보여 주고,
 * 연도가 통째로 밀린 묶음은 한 번에 ±1년 옮긴다(POST /api/groups/:gid/matches/shift-dates).
 * 찾기만 할 뿐 사람이 확인하기 전에는 아무것도 바꾸지 않는다. 계산은 src/shared/dateCheck.ts(가져오기 미리보기와 공용).
 */
export function DateCheck() {
  const app = useAppValue();
  const snapshot = app.snapshot;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rangeFrom, setRangeFrom] = useState("");
  const [rangeTo, setRangeTo] = useState("");
  const [rangeYears, setRangeYears] = useState<1 | -1>(1);
  const [confirm, setConfirm] = useState<{ items: MatchView[]; years: 1 | -1 } | null>(null);
  // 요청 ID: 같은 경기·같은 방향을 다시 보내면(실패·확인 불가 뒤) 같은 값을 쓴다. 성공하면 비운다.
  // 옮기기는 두 번 하면 두 해가 밀리므로, 앞 요청이 실제로 저장됐을 때 서버가 두 번 처리하지 않게 하는 것이 중요하다.
  const request = useRef<{ id: string; key: string } | null>(null);

  const tz = snapshot?.group.timezone ?? "Asia/Seoul";
  const confirmed = useMemo(
    () => (snapshot ? snapshot.matches.filter((m) => m.state === "confirmed") : []),
    [snapshot],
  );
  // 전적 제외 경기는 찾기에는 쓰지 않지만, 옮길 때는 같은 묶음·범위에 있으면 함께 옮긴다(제외 상태는 그대로라
  // 통계에는 영향이 없다). 같은 묶음의 제외 경기만 틀린 연도로 남지 않게 하려는 것이다(2026-11-08 정합성 점검).
  const excluded = useMemo(
    () => (snapshot ? snapshot.matches.filter((m) => m.state === "excluded") : []),
    [snapshot],
  );
  const findings = useMemo(
    () =>
      dateFindings(confirmed, (m) => ({
        key: m.id,
        order: m.matchNo,
        at: Date.parse(m.playedAt),
        people: m.roster.map((r) => r.participantId),
      })),
    [confirmed],
  );

  if (!snapshot) {
    return (
      <div className="screen">
        <header className="screen-head">
          <BackLink fallback={() => go("/group")} label="← 모임" />
          <h1>날짜 점검</h1>
        </header>
        <p>아직 기록이 없어요.</p>
      </div>
    );
  }

  // 연도가 바뀌는 것을 보여 주는 화면이라 날짜에 연도를 넣는다(YYYY-MM-DD, 모임 시간대).
  const whenIso = (iso: string) => `${localDate(iso, tz)} ${formatTime(iso, tz)}`;
  const when = (m: MatchView) => whenIso(m.playedAt);

  async function apply(items: MatchView[], years: 1 | -1) {
    const matchIds = items.map((m) => m.id);
    const key = `${years}:${matchIds.join(",")}`;
    if (request.current?.key !== key) request.current = { id: newRequestId(), key };
    setBusy(true);
    setError(null);
    try {
      await mutate(`/api/groups/${snapshot!.group.id}/matches/shift-dates`, {
        requestId: request.current.id,
        matchIds,
        years,
      });
      request.current = null;
      await app.refreshAfterOwnChange();
      setConfirm(null);
      app.setNotice(`${items.length}경기의 연도를 ${years > 0 ? "한 해 뒤로" : "한 해 앞으로"} 옮겼어요. 변경 내역에 남아요.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const rangeItems = (() => {
    const from = Number(rangeFrom);
    const to = Number(rangeTo);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) return [];
    return [...confirmed, ...excluded]
      .filter((m) => m.matchNo >= from && m.matchNo <= to)
      .sort((a, b) => a.matchNo - b.matchNo);
  })();

  /**
   * 묶음을 옮길 때 함께 옮길 제외 경기를 더한다. 묶음과 같은 기준으로 고른다: 연도 +1 묶음은 경기 번호가 묶음 안이고
   * 날짜가 기준(바로 앞 경기)보다 앞인 것, 미래 묶음(−1)은 아직 오지 않은 시각인 것.
   */
  const runTargets = (run: YearRun<MatchView>): MatchView[] => {
    const first = run.items[0]!.matchNo;
    const last = run.items[run.items.length - 1]!.matchNo;
    const extra = excluded.filter((m) => {
      const at = Date.parse(m.playedAt);
      if (run.before) return m.matchNo >= first && m.matchNo <= last && at < Date.parse(run.before.playedAt);
      return at > Date.now() + FUTURE_TOLERANCE_MS;
    });
    return [...run.items, ...extra].sort((a, b) => a.matchNo - b.matchNo);
  };

  const preview = (items: MatchView[], years: 1 | -1) => {
    const shown = items.length <= 4 ? items : [...items.slice(0, 3), items[items.length - 1]!];
    return (
      <ul className="list" aria-label="바뀌기 전과 후">
        {shown.map((m, i) => (
          <li key={m.id} className="list-row static">
            <span className="name">
              {items.length > 4 && i === 3 ? "… " : ""}
              {m.matchNo}경기
            </span>
            <span className="stat">
              {when(m)} → {whenIso(shiftYears(m.playedAt, years, tz))}
              {m.state === "excluded" ? " (전적 제외)" : ""}
            </span>
          </li>
        ))}
      </ul>
    );
  };

  const runBlock = (run: YearRun<MatchView>, index: number) => {
    const first = run.items[0]!;
    const last = run.items[run.items.length - 1]!;
    const targets = runTargets(run);
    const extra = targets.length - run.items.length;
    return (
      <section key={index} className="prep-tools" aria-label={`연도 묶음 ${index + 1}`}>
        <h2>
          {first.matchNo}경기 ~ {last.matchNo}경기 <span className="side">{run.items.length}경기</span>
        </h2>
        <p className="hint">
          {run.before
            ? `바로 앞 ${run.before.matchNo}경기(${localDate(run.before.playedAt, tz)})보다 날짜가 반년 넘게 앞으로 돌아가요. 해를 안 넘긴 것 같아요.`
            : "아직 오지 않은 날짜예요. 한 해 앞으로 옮기면 지난 경기가 돼요."}
          {extra > 0 ? ` 전적 제외 경기 ${extra}개도 함께 옮겨요(통계에는 그대로 빠져 있어요).` : ""}
        </p>
        {preview(targets, run.years)}
        <div className="button-row">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => setConfirm({ items: targets, years: run.years })}
          >
            {run.years > 0 ? "연도 +1 적용" : "연도 −1 적용"}
          </button>
          <button type="button" className="link" onClick={() => go(`/m/${first.id}`)}>
            첫 경기 보기
          </button>
        </div>
      </section>
    );
  };

  const clean = findings.yearRuns.length === 0 && findings.sameTime.length === 0;

  return (
    <div className="screen">
      <header className="screen-head">
        <BackLink fallback={() => go("/group")} label="← 모임" />
        <h1>날짜 점검</h1>
      </header>
      <p className="hint">
        확정 경기 {findings.checked}개를 입력 순서(경기 번호)와 견줘 날짜가 맥락에 안 맞는 곳을 찾았어요. 여기서는 찾기만
        하고, 적용을 눌러야 바뀝니다.
      </p>
      <Help>
        <p>연도 묶음: 입력 순서는 뒤인데 날짜가 반년 넘게 앞으로 돌아간 자리부터, 돌아가기 전 날짜를 다시 넘기기 전까지. 보통 12월 → 1월에서 해를 안 넘긴 경우라 연도 +1을 제안해요. 아직 오지 않은 날짜는 −1을 제안해요.</p>
        <p>같은 시각: 시각이 정확히 같은 경기 둘 이상. 열 명까지 같으면 같은 경기를 두 번 넣었을 수 있어요. 경기 상세에서 시각을 고치거나 전적 제외로 빼세요.</p>
        <p>적용하면 경기마다 "경기 시각 수정" 정정 기록이 남고, 같은 범위에 반대 부호를 적용하면 되돌아가요. 전적·통계는 바로 다시 계산돼요. 전적 제외 경기는 찾기에는 쓰지 않지만 같은 묶음·범위에 있으면 함께 옮겨요(제외 상태는 그대로).</p>
      </Help>
      <ErrorNote error={error} />

      {clean && <p className="note">맥락에 안 맞는 날짜를 찾지 못했어요.</p>}

      {findings.yearRuns.length > 0 && (
        <>
          <h2>연도가 밀린 것 같은 묶음 {findings.yearRuns.length}개</h2>
          {findings.yearRuns.map(runBlock)}
        </>
      )}

      {findings.sameTime.length > 0 && (
        <section className="prep-tools" aria-label="같은 시각 경기">
          <h2>
            같은 시각 경기 <span className="side">{findings.sameTime.length}묶음</span>
          </h2>
          <ul className="list" aria-label="같은 시각 목록">
            {findings.sameTime.map((g) => (
              <li key={g.at} className="list-row static same-time">
                <span className="name">
                  {when(g.items[0]!)}{" "}
                  {g.sameRoster && <span className="tag warn-tag">열 명이 같아요 · 중복일 수 있어요</span>}
                </span>
                <span className="button-row">
                  {g.items.map((m) => (
                    <button key={m.id} type="button" className="link" onClick={() => go(`/m/${m.id}`)}>
                      {m.matchNo}경기
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className="hint">같은 시각에 두 방이 동시에 돌았을 수도 있어요. 사람이 보고 정하세요.</p>
        </section>
      )}

      <section className="prep-tools" aria-label="범위 직접 고르기">
        <h2>범위 직접 고르기</h2>
        <p className="hint">경기 번호 범위를 적고 연도를 옮겨요. 위 묶음이 맞지 않을 때 쓰세요.</p>
        <div className="button-row">
          <label className="inline-label">
            시작 경기
            <input
              type="number"
              min={1}
              inputMode="numeric"
              value={rangeFrom}
              onChange={(e) => setRangeFrom(e.target.value)}
              aria-label="시작 경기 번호"
            />
          </label>
          <label className="inline-label">
            끝 경기
            <input
              type="number"
              min={1}
              inputMode="numeric"
              value={rangeTo}
              onChange={(e) => setRangeTo(e.target.value)}
              aria-label="끝 경기 번호"
            />
          </label>
          <label className="inline-label">
            연도
            <select value={rangeYears} onChange={(e) => setRangeYears(Number(e.target.value) as 1 | -1)} aria-label="연도 이동">
              <option value={1}>+1 (한 해 뒤로)</option>
              <option value={-1}>−1 (한 해 앞으로)</option>
            </select>
          </label>
        </div>
        {rangeItems.length > 0 && (
          <>
            <p className="hint">{rangeItems.length}경기가 바뀝니다.</p>
            {preview(rangeItems, rangeYears)}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setConfirm({ items: rangeItems, years: rangeYears })}
            >
              이 범위에 적용
            </button>
          </>
        )}
      </section>

      {confirm && (
        <Dialog title="연도 옮기기 확인" onClose={() => setConfirm(null)}>
          <p>
            {confirm.items.length}경기({confirm.items[0]!.matchNo}경기 ~ {confirm.items[confirm.items.length - 1]!.matchNo}
            경기)의 연도를 {confirm.years > 0 ? "한 해 뒤로" : "한 해 앞으로"} 옮깁니다. 경기마다 정정 기록이 남고, 같은
            범위에 반대로 적용하면 되돌아가요.
          </p>
          <ErrorNote error={error} />
          <div className="button-row">
            <button type="button" className="primary" disabled={busy} onClick={() => void apply(confirm.items, confirm.years)}>
              {busy ? "옮기는 중" : "옮기기"}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setConfirm(null)}>
              그대로 두기
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
