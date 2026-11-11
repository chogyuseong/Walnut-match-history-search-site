import { useRef, useState } from "react";
import {
  backfillNames,
  backfillProblems,
  backfillRequest,
  emptyBackfillForm,
  type BackfillForm,
  type BackfillSide,
} from "../../shared/backfill";
import { cleanName, MAX_NAME_LENGTH, nameKey } from "../../shared/names";
import { localDate, safeTimeZone } from "../../shared/stats";
import { POSITIONS, TEAMS, type MatchView, type Position, type Team } from "../../shared/types";
import { mutate, newRequestId } from "../api";
import { formatDate, formatTime, POSITION_LABEL, TEAM_MARK, winnerText } from "../format";
import { ErrorNote } from "../ui";
import { go, useAppValue } from "../useApp";
import { CreateGroupButton } from "../account";

/** 모임 시간대의 지금 날짜·시각. 폼의 처음 값으로 쓴다. */
function nowInZone(timeZone: string): { date: string; time: string } {
  const now = new Date();
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeTimeZone(timeZone),
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  return { date: localDate(now.toISOString(), timeZone), time };
}

const SIDE_CHOICES: { value: BackfillSide; title: string; hint: string }[] = [
  {
    value: "unknown",
    title: "진영 미상",
    hint: "기억나지 않을 때. 승패와 배치에는 들어가고 진영 통계에서만 빠집니다.",
  },
  { value: "a-blue", title: "팀 A가 블루", hint: "팀 B는 레드입니다." },
  { value: "a-red", title: "팀 A가 레드", hint: "팀 B는 블루입니다." },
];

/**
 * 지난 경기 한 건 입력. 이미 끝난 경기의 결과를 바로 확정 경기로 넣는다.
 * 오늘 내전(세션), 진행 중 경기, 서포터 횟수에는 영향이 없다.
 */
export function Backfill() {
  const app = useAppValue();
  const snapshot = app.snapshot;
  const tz = snapshot?.group.timezone ?? "Asia/Seoul";
  const [form, setForm] = useState<BackfillForm>(() => {
    const now = nowInZone(tz);
    return emptyBackfillForm(now.date, now.time);
  });
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState<MatchView | null>(null);
  // 같은 내용을 다시 보내면 같은 요청 ID를 써서 두 번 저장되지 않게 한다. 내용이 바뀌면 새 ID다.
  const pending = useRef<{ key: string; requestId: string } | null>(null);

  if (!snapshot) {
    return (
      <div className="screen">
        <h1>지난 경기 입력</h1>
        <p>모임이 있어야 기록을 넣을 수 있어요. 경기를 하지 않아도 모임을 먼저 만들 수 있어요.</p>
        <div className="button-row">
          <CreateGroupButton primary label="모임 만들고 시작" to="/backfill" />
          <button type="button" className="secondary" onClick={() => go("/")}>
            오늘로 가기
          </button>
        </div>
      </div>
    );
  }
  const gid = snapshot.group.id;
  const active = snapshot.participants
    .filter((p) => p.status === "active")
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const known = new Set(active.map((p) => nameKey(p.name)));
  const problems = backfillProblems(form, tz, new Date());
  const newNames = [
    ...new Set(
      backfillNames(form).filter((n) => n !== "" && !known.has(nameKey(n))),
    ),
  ];

  const setSlot = (team: Team, index: number, patch: Partial<BackfillForm["teams"]["A"][number]>) =>
    setForm((f) => ({
      ...f,
      teams: {
        ...f.teams,
        [team]: f.teams[team].map((s, i) => (i === index ? { ...s, ...patch } : s)),
      },
    }));

  async function save() {
    setTried(true);
    if (problems.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const names = backfillNames(form);
      // 목록에 있는 이름은 그 참가자, 없는 이름은 새 참가자가 된다(같은 이름이면 같은 참가자).
      const ensured = await mutate<{ participants: { id: string }[] }>(`/api/groups/${gid}/participants`, {
        requestId: newRequestId(),
        names,
      });
      const idOf = new Map(names.map((n, i) => [nameKey(n), ensured.participants[i]!.id]));
      const body = backfillRequest(form, tz, (n) => idOf.get(nameKey(n))!);
      const key = JSON.stringify(body);
      if (!pending.current || pending.current.key !== key) {
        pending.current = { key, requestId: newRequestId() };
      }
      const result = await mutate<{ match: MatchView }>(`/api/groups/${gid}/matches/backfill`, {
        requestId: pending.current.requestId,
        ...body,
      });
      pending.current = null;
      setSaved(result.match);
      await app.refreshAfterOwnChange();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <div className="screen">
        <header className="screen-head">
          <h1>지난 경기 입력</h1>
        </header>
        <section className="card" aria-label="저장 완료">
          <p className="saved" role="status">
            <strong>
              {saved.matchNo}경기 저장됨 · {formatDate(saved.playedAt, tz)}{" "}
              {formatTime(saved.playedAt, tz)} · {winnerText(saved.winnerTeam!, saved.teamASide)}
            </strong>
          </p>
          <p className="hint">통계와 배치 판수에 바로 들어갑니다. 오늘 내전과 서포터 횟수는 그대로입니다.</p>
          <div className="button-row">
            <button type="button" className="primary" onClick={() => go(`/m/${saved.id}`)}>
              이 경기 보기
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                // 날짜·시각은 남겨 같은 날 경기를 이어서 넣기 쉽게 한다.
                setForm((f) => emptyBackfillForm(f.date, f.time));
                setSaved(null);
                setTried(false);
              }}
            >
              한 경기 더 넣기
            </button>
            <button type="button" className="link" onClick={() => go("/records")}>
              기록 보기
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="link" onClick={() => go("/group")}>
          ← 모임
        </button>
        <h1>지난 경기 입력</h1>
      </header>
      <p className="hint">
        이미 끝난 경기 하나를 결과까지 넣습니다. 오늘 내전, 진행 중인 경기, 서포터 횟수에는 영향이
        없습니다. 여러 경기는{" "}
        <button type="button" className="link" onClick={() => go("/import")}>
          표 일괄 입력
        </button>
        을 쓰세요.
      </p>

      <form
        className="backfill"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy}>
          <legend>언제 했나요?</legend>
          <div className="input-row backfill-when">
            <label>
              날짜
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
              />
            </label>
            <label>
              시각
              <input
                type="time"
                value={form.time}
                onChange={(e) => setForm({ ...form, time: e.target.value })}
              />
            </label>
          </div>
          <p className="hint">모임 시간대({tz}) 기준입니다.</p>
        </fieldset>

        <datalist id="backfill-people">
          {active.map((p) => (
            <option key={p.id} value={p.name} />
          ))}
        </datalist>

        {TEAMS.map((team) => (
          <fieldset key={team} disabled={busy} className="backfill-team">
            <legend>
              <span aria-hidden="true">{TEAM_MARK[team]}</span> 팀 {team} · 이름과 포지션
            </legend>
            <ul className="list">
              {form.teams[team].map((slot, index) => (
                <li key={index} className="backfill-slot">
                  {/* 보이는 꼬리표: 칸이 비어도 몇 번째 사람 칸인지 보이게(예전엔 placeholder가 라벨 노릇을 했다). */}
                  <span className="backfill-no" aria-hidden="true">
                    {index + 1}
                  </span>
                  <input
                    aria-label={`팀 ${team} ${index + 1}번 이름`}
                    list="backfill-people"
                    autoComplete="off"
                    maxLength={MAX_NAME_LENGTH + 10}
                    value={slot.name}
                    onChange={(e) => setSlot(team, index, { name: e.target.value })}
                  />
                  <select
                    aria-label={`팀 ${team} ${index + 1}번 포지션`}
                    value={slot.position}
                    onChange={(e) => setSlot(team, index, { position: e.target.value as Position | "" })}
                  >
                    <option value="">포지션 없음</option>
                    {POSITIONS.map((p) => (
                      <option key={p} value={p}>
                        {POSITION_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </li>
              ))}
            </ul>
          </fieldset>
        ))}
        <p className="hint">
          이름을 누르면 지금 참가자 목록에서 고를 수 있어요. 목록에 없는 이름은 새 참가자로 만듭니다.
          포지션은 몰라도 됩니다.
        </p>
        {newNames.length > 0 && (
          <p className="note" role="status">
            새로 만들 참가자 {newNames.length}명: {newNames.map(cleanName).join(", ")}
          </p>
        )}

        <fieldset disabled={busy}>
          <legend>이긴 팀</legend>
          <div className="choice-row">
            {TEAMS.map((team) => (
              <label key={team} className={form.winner === team ? "choice chosen" : "choice"}>
                <input
                  type="radio"
                  name="backfill-winner"
                  checked={form.winner === team}
                  onChange={() => setForm({ ...form, winner: team })}
                />
                <span>
                  <span aria-hidden="true">{TEAM_MARK[team]}</span> 팀 {team} 승
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={busy}>
          <legend>진영</legend>
          {SIDE_CHOICES.map((choice) => (
            <label
              key={choice.value}
              className={form.side === choice.value ? "choice chosen" : "choice"}
            >
              <input
                type="radio"
                name="backfill-side"
                checked={form.side === choice.value}
                onChange={() => setForm({ ...form, side: choice.value })}
              />
              <span>
                <strong>{choice.title}</strong>
                <br />
                <span className="hint">{choice.hint}</span>
              </span>
            </label>
          ))}
          <p className="hint">나중에 경기 상세에서 진영·승리 팀·포지션·참가자를 고칠 수 있습니다.</p>
        </fieldset>

        {tried && problems.length > 0 && (
          <div className="note error" role="alert">
            <p>
              <strong>아직 저장할 수 없어요.</strong>
            </p>
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        )}
        <ErrorNote error={error} onCheck={() => void save()} />
        <button type="submit" className="primary wide" disabled={busy}>
          {busy ? "저장 중" : "이 경기 저장"}
        </button>
      </form>
    </div>
  );
}
