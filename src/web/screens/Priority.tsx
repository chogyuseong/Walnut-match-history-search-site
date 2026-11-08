import { useMemo, useState } from "react";
import { MAX_AVOID } from "../../shared/avoid";
import {
  normalizePriority,
  priorityLabel,
  PRIORITY_CLASSES,
  type Priority,
} from "../../shared/priority";
import {
  balanceCheck,
  changedSuggestions,
  priorityMismatches,
  suggestPriorities,
  SUGGEST_MIN_PEOPLE,
  SUGGEST_PRIOR_GAMES,
  type SuggestResult,
  type SuggestRow,
} from "../../shared/priorityReview";
import { PLACEMENT_GAMES, SMALL_SAMPLE } from "../../shared/stats";
import {
  POSITIONS,
  type ParticipantView,
  type Position,
  type Snapshot,
} from "../../shared/types";
import { patchParticipant } from "../api";
import { POSITION_LABEL } from "../format";
import { Dialog, ErrorNote, PosLabel } from "../ui";
import { go, useAppValue, type AppValue } from "../useApp";

/**
 * 티어 배정(#/priority)과 기피 라인(#/priority/avoid). 로그인한 운영자·공동 운영자만(App.tsx LOGIN_ONLY). 조회 링크에는 없다.
 * 티어: 1·2·3·4·5티어·미지정 여섯 칸에 활성 참가자를 보여 주고, 사람마다 버튼으로 칸을 바꾼다.
 *   저장은 모임 탭과 같은 참가자 수정 API(PATCH …/participants/:id, skillGroup)다. 공개 설정(groupsPublic)은 모임 탭에 있다.
 *   "기록으로 제안받기"(승률로 5등분한 참고값, 고른 사람만 적용)와 "티어 점검"(지금 티어를 지난 경기에 적용한 계산)이 함께 있다.
 * 기피 라인: 사람마다 탑·정글·미드·원딜·서폿 토글(0~4개). 같은 API의 avoidPositions로 바로 저장한다.
 */
export function PriorityScreen(props: { tab?: "priority" | "avoid" }) {
  const app = useAppValue();
  const snapshot = app.snapshot;
  const tab = props.tab ?? "priority";
  const title = tab === "avoid" ? "기피 라인" : "티어 배정";

  // 측면 요약 판의 "돌아가기" 버튼. 머리의 "← …" 링크와 이름을 다르게 두어 둘이 겹치지 않는다.
  const backTo = app.draft
    ? { path: "/prep", label: "다음 경기 준비로 돌아가기" }
    : { path: "/group", label: "모임으로 돌아가기" };

  const back = app.draft ? (
    <button type="button" className="link" onClick={() => go("/prep")}>
      ← 다음 경기 준비
    </button>
  ) : (
    <button type="button" className="link" onClick={() => go("/group")}>
      ← 모임
    </button>
  );

  const tabs = (
    <div
      className="segmented priority-tabs"
      role="tablist"
      aria-label="티어 또는 기피 라인"
    >
      {(
        [
          ["priority", "티어", "/priority"],
          ["avoid", "기피 라인", "/priority/avoid"],
        ] as const
      ).map(([value, label, path]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={tab === value}
          onClick={() => {
            if (tab !== value) go(path);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (!snapshot) {
    return (
      <div className="screen priority-screen">
        <header className="screen-head sticky-head priority-head">
          {back}
          <h1>{title}</h1>
          {tabs}
        </header>
        <p>
          아직 참가자가 없어요. 경기를 한 번 시작하거나 참가자를 넣으면 여기서
          정할 수 있어요.
        </p>
      </div>
    );
  }
  const people = snapshot.participants
    .filter((p) => p.status === "active" && !p.mergedInto)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  // 이번 편성에 든 사람은 표시해 준다(준비 화면에서 들어온 경우 누구를 정해야 하는지 보이게).
  const inDraft = new Set(
    (app.draft?.people ?? [])
      .map((p) => p.participantId)
      .filter((id) => id !== null),
  );

  return (
    <div className="screen priority-screen">
      {/* 머리(뒤로·제목·탭)가 화면을 내려도 따라온다(2026-11-08). 배정한 뒤 위로 올라가지 않아도 되게. */}
      <header className="screen-head sticky-head priority-head">
        {back}
        <h1>{title}</h1>
        {tabs}
      </header>
      {tab === "avoid" ? (
        <AvoidPanel
          app={app}
          snapshot={snapshot}
          people={people}
          inDraft={inDraft}
          back={backTo}
        />
      ) : (
        <PriorityPanel
          app={app}
          snapshot={snapshot}
          people={people}
          inDraft={inDraft}
          back={backTo}
        />
      )}
    </div>
  );
}

interface PanelProps {
  app: AppValue;
  snapshot: Snapshot;
  people: ParticipantView[];
  inDraft: ReadonlySet<string | null>;
  /** 측면 요약 판의 돌아가기 버튼. */
  back: { path: string; label: string };
}

/** 티어 구역의 앵커 id(측면 판에서 누르면 그 구역으로). */
const tierId = (cls: Priority) => `tier-${cls ?? "none"}`;

/**
 * PC(1024px 이상)에서 오른쪽에 따라 내려오는 요약 판(CSS .priority-side, 좁은 화면에서는 숨김).
 * 줄마다 수를 보여 주고 id가 있으면 눌러서 그 구역으로 간다. 맨 아래는 돌아가기.
 */
function PrioritySide(props: {
  label: string;
  rows: { id?: string; label: string; count: number }[];
  back: { path: string; label: string };
}) {
  return (
    <aside className="priority-side" aria-label={props.label}>
      <ul className="priority-counts">
        {props.rows.map((row) => (
          <li key={row.label}>
            {row.id ? (
              <button
                type="button"
                className="priority-jump"
                onClick={() =>
                  document
                    .getElementById(row.id!)
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                <span>{row.label}</span>
                <strong>{row.count}명</strong>
              </button>
            ) : (
              <span className="priority-jump static">
                <span>{row.label}</span>
                <strong>{row.count}명</strong>
              </span>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="primary wide"
        onClick={() => go(props.back.path)}
      >
        {props.back.label}
      </button>
    </aside>
  );
}

function PriorityPanel({ app, snapshot, people, inDraft, back }: PanelProps) {
  // 누른 즉시 칸을 옮겨 보이고(저장 중), 저장이 끝나 다시 읽으면 지운다.
  const [pending, setPending] = useState<Record<string, Priority>>({});
  const [error, setError] = useState<unknown>(null);
  const [suggesting, setSuggesting] = useState(false);

  const valueOf = (id: string, saved: number | null | undefined): Priority =>
    id in pending ? pending[id]! : normalizePriority(saved);

  async function choose(id: string, name: string, value: Priority) {
    setError(null);
    setPending((prev) => ({ ...prev, [id]: value }));
    try {
      await patchParticipant(snapshot, id, { skillGroup: value });
      await app.refreshAfterOwnChange();
      app.setNotice(`${name}: ${priorityLabel(value)}`);
    } catch (e) {
      setError(e);
      void app.refresh();
    } finally {
      setPending((prev) => {
        const { [id]: _done, ...rest } = prev;
        return rest;
      });
    }
  }

  return (
    <div className="priority-layout">
      <div className="priority-main">
        <p className="hint">
          1티어가 가장 잘하는 사람이에요. 같은 티어끼리는 팀·라인 모두 섞기·팀
          추천에서 양 팀에 나뉘어요. 미지정은 못하는 사람이 아니라 아직 안 정한
          사람이에요.
        </p>
        <p className="hint">
          사람 옆의 1·2·3·4·5·미정 중 하나를 누르면 바로 저장돼요. 공식 등급이
          아니라 운영 기준이에요.
          {snapshot.group.settings.groupsPublic
            ? " 지금 조회자에게도 공개돼 있어요(모임 탭에서 바꿀 수 있어요)."
            : " 운영자만 봐요."}
        </p>
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            onClick={() => setSuggesting(true)}
          >
            기록으로 제안받기
          </button>
        </div>
        <ErrorNote error={error} />
        {people.length === 0 && <p>참가자가 없어요.</p>}
        {PRIORITY_CLASSES.map((cls) => {
          const members = people.filter(
            (p) => valueOf(p.id, p.skillGroup) === cls,
          );
          const label = priorityLabel(cls);
          return (
            <section
              key={label}
              id={tierId(cls)}
              className="prep-tools"
              aria-label={label}
            >
              <h2>
                {label} <span className="side">{members.length}명</span>
              </h2>
              {members.length === 0 ? (
                <p className="hint">아직 없어요.</p>
              ) : (
                <ul className="list">
                  {members.map((p) => (
                    <li key={p.id} className="list-row static priority-row">
                      <span className="name">
                        {p.name}
                        {inDraft.has(p.id) && (
                          <span className="tag">이번 편성</span>
                        )}
                      </span>
                      <span
                        className="segmented"
                        role="group"
                        aria-label={`${p.name}의 티어`}
                      >
                        {PRIORITY_CLASSES.map((value) => (
                          <button
                            key={priorityLabel(value)}
                            type="button"
                            aria-label={`${p.name} ${priorityLabel(value)}`}
                            aria-pressed={valueOf(p.id, p.skillGroup) === value}
                            disabled={p.id in pending}
                            onClick={() => {
                              if (valueOf(p.id, p.skillGroup) !== value)
                                void choose(p.id, p.name, value);
                            }}
                          >
                            {value === null ? "미정" : value}
                          </button>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        <PriorityCheck snapshot={snapshot} />
      </div>
      <PrioritySide
        label="티어 요약"
        rows={PRIORITY_CLASSES.map((cls) => ({
          id: tierId(cls),
          label: priorityLabel(cls),
          count: people.filter((p) => valueOf(p.id, p.skillGroup) === cls)
            .length,
        }))}
        back={back}
      />
      {suggesting && (
        <SuggestDialog
          app={app}
          snapshot={snapshot}
          onClose={() => setSuggesting(false)}
        />
      )}
    </div>
  );
}

const percent = (wins: number, games: number) =>
  `${Math.round((wins / games) * 100)}%`;

function rowFacts(row: SuggestRow): string {
  // 다른 화면과 같은 꼴: "승률 · N승 M패 (G경기)"
  return row.games === 0
    ? "경기 없음"
    : `${percent(row.wins, row.games)} · ${row.wins}승 ${row.games - row.wins}패 (${row.games}경기)`;
}

/** 기록으로 제안받기: 미리보기 → 고른 사람만 저장. 자동으로 덮어쓰지 않는다. */
function SuggestDialog(props: {
  app: AppValue;
  snapshot: Snapshot;
  onClose: () => void;
}) {
  const { app, snapshot } = props;
  // 창을 연 때의 기록으로 계산해 둔다(적용 중 다시 읽어도 목록이 흔들리지 않게).
  const [result] = useState<SuggestResult>(() =>
    suggestPriorities(snapshot.participants, snapshot.matches),
  );
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(changedSuggestions(result).map((r) => r.participantId)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const suggested = result.rows.filter((r) => r.suggested !== null);
  const few = result.rows.filter((r) => r.status === "few-games");

  async function applyChecked() {
    setBusy(true);
    setError(null);
    const targets = suggested.filter((r) => checked.has(r.participantId));
    let done = 0;
    try {
      for (const row of targets) {
        await patchParticipant(snapshot, row.participantId, {
          skillGroup: row.suggested,
        });
        done += 1;
      }
      await app.refreshAfterOwnChange();
      app.setNotice(`${done}명의 티어를 바꿨어요.`);
      props.onClose();
    } catch (e) {
      setError(e);
      void app.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="기록으로 제안받기" onClose={props.onClose}>
      <p className="hint">
        제안은 승률만 본 참고값이에요(라인·상대·최근 흐름은 보지 않아요). 누적{" "}
        {PLACEMENT_GAMES}경기 이상인 사람만, 경기가 적을수록 승률을 50% 쪽으로
        당겨({SUGGEST_PRIOR_GAMES}경기만큼) 줄 세운 뒤 5등분했어요.
      </p>
      {!result.ready ? (
        <p className="note" role="status">
          누적 {PLACEMENT_GAMES}경기 이상인 사람이 {SUGGEST_MIN_PEOPLE}명
          이상이어야 제안할 수 있어요. 지금 {result.eligible}명이에요.
        </p>
      ) : (
        <>
          <p className="hint">
            달라지는 사람만 미리 골라 뒀어요. 적용을 눌러야 저장돼요.
          </p>
          <ul className="list" aria-label="제안 목록">
            {suggested.map((row) => {
              const same = row.suggested === row.current;
              return (
                <li key={row.participantId} className="list-row static">
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={checked.has(row.participantId)}
                      disabled={busy}
                      onChange={(e) =>
                        setChecked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(row.participantId);
                          else next.delete(row.participantId);
                          return next;
                        })
                      }
                    />
                    <span>
                      <strong>{row.name}</strong> {priorityLabel(row.current)} →{" "}
                      {priorityLabel(row.suggested)}
                      {same && <span className="tag">그대로</span>}
                      <br />
                      <span className="hint">{rowFacts(row)}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {few.length > 0 && (
        <details>
          <summary>기록이 적어 제안 없음 {few.length}명</summary>
          <ul className="list" aria-label="기록이 적어 제안 없음">
            {few.map((row) => (
              <li key={row.participantId} className="list-row static">
                <span className="name">{row.name}</span>
                <span className="stat">
                  {row.games}경기 · {priorityLabel(row.current)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <ErrorNote error={error} />
      <div className="button-row">
        {result.ready && (
          <button
            type="button"
            className="primary"
            disabled={busy || checked.size === 0}
            onClick={() => void applyChecked()}
          >
            {busy ? "저장 중" : `선택한 ${checked.size}명 적용`}
          </button>
        )}
        <button type="button" className="secondary" onClick={props.onClose}>
          닫기
        </button>
      </div>
    </Dialog>
  );
}

/** 티어 점검: 지금 티어를 지난 확정 경기에 적용해 본 계산. 운영자만 보는 화면이다. */
function PriorityCheck(props: { snapshot: Snapshot }) {
  const { snapshot } = props;
  const balance = useMemo(
    () =>
      balanceCheck(
        snapshot.participants,
        snapshot.matches,
        snapshot.group.settings.groupWeights,
      ),
    [snapshot],
  );
  const mismatches = useMemo(
    () =>
      priorityMismatches(
        suggestPriorities(snapshot.participants, snapshot.matches),
      ),
    [snapshot],
  );
  const far = mismatches.filter((m) => m.kind === "far");
  const unset = mismatches.filter((m) => m.kind === "unset");
  return (
    <section className="prep-tools" aria-label="티어 점검">
      <h2>티어 점검</h2>
      <p className="hint">
        경기 당시의 티어는 저장하지 않아요. 지금 티어를 지난 경기에 적용해
        계산한 값이에요.
      </p>
      <h3>티어 점수 합이 높은 팀이 이긴 비율</h3>
      {balance.small ? (
        <p>
          자료 적음{" "}
          <span className="hint">
            (두 팀 티어 점수 합이 달랐던 경기 {balance.uneven}경기,{" "}
            {SMALL_SAMPLE}경기부터 보여 줘요)
          </span>
        </p>
      ) : (
        <p>
          두 팀 티어 점수 합이 달랐던 {balance.uneven}경기 중 합이 높은 팀이{" "}
          {balance.higherWon}승 ({percent(balance.higherWon, balance.uneven)})
        </p>
      )}
      <p className="hint">합이 같았던 경기 {balance.even}경기는 빼고 셌어요.</p>
      <h3>티어와 성적이 어긋나는 사람</h3>
      {far.length === 0 ? (
        <p className="hint">
          지금 티어와 기록 제안이 2단계 이상 다른 사람은 없어요.
        </p>
      ) : (
        <ul className="list" aria-label="티어와 성적이 어긋나는 사람">
          {far.map(({ row }) => (
            <li key={row.participantId} className="list-row static">
              <span className="name">{row.name}</span>
              <span className="stat">
                지금 {priorityLabel(row.current)} · 제안{" "}
                {priorityLabel(row.suggested)} · {rowFacts(row)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {unset.length > 0 && (
        <>
          <h3>아직 안 정함</h3>
          <ul className="list" aria-label="아직 안 정함">
            {unset.map(({ row }) => (
              <li key={row.participantId} className="list-row static">
                <span className="name">{row.name}</span>
                <span className="stat">
                  제안 {priorityLabel(row.suggested)} · {rowFacts(row)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** 기피 라인: 사람마다 다섯 라인 토글. 누르면 바로 저장. 다섯 개 모두는 고를 수 없다. */
function AvoidPanel({ app, snapshot, people, inDraft, back }: PanelProps) {
  const [pending, setPending] = useState<Record<string, Position[]>>({});
  const [error, setError] = useState<unknown>(null);
  const listOf = (p: ParticipantView): Position[] =>
    pending[p.id] ?? p.avoidPositions ?? [];
  // 본인과 연결한 참가자가 직접 정한 기피 라인(migrations/0019). 운영자가 고치면 표시가 사라진다.
  const selfSet = new Set(
    (snapshot.memberLinks ?? [])
      .filter((l) => l.avoidBySelf)
      .map((l) => l.participantId),
  );

  async function toggle(p: ParticipantView, position: Position) {
    const current = listOf(p);
    const on = current.includes(position);
    if (!on && current.length >= MAX_AVOID) {
      app.setNotice(
        `기피 라인은 ${MAX_AVOID}개까지예요. 한 라인은 갈 수 있어야 해요.`,
      );
      return;
    }
    const next = on
      ? current.filter((x) => x !== position)
      : POSITIONS.filter((x) => x === position || current.includes(x));
    setError(null);
    setPending((prev) => ({ ...prev, [p.id]: next }));
    try {
      await patchParticipant(snapshot, p.id, { avoidPositions: next });
      await app.refreshAfterOwnChange();
      app.setNotice(
        next.length === 0
          ? `${p.name}: 기피 라인 없음`
          : `${p.name}: ${next.map((x) => POSITION_LABEL[x]).join("·")} 기피`,
      );
    } catch (e) {
      setError(e);
      void app.refresh();
    } finally {
      setPending((prev) => {
        const { [p.id]: _done, ...rest } = prev;
        return rest;
      });
    }
  }

  return (
    <div className="priority-layout">
      <div className="priority-main">
        <p className="hint">
          고른 라인은 라인 섞기(라인만 섞기·팀·라인 모두 섞기·팀 추천 적용·처음
          팀 짜기)에서 되도록 피해요. 모두 피할 수 없으면 가장 적게 어기는
          배정을 고르고 알려 줘요. 포지션 고정이 먼저이고, 손으로 자리를 바꾸는
          것은 막지 않아요.
        </p>
        <p className="hint">
          서폿 돌아가며·서포터만 바꾸기는 서포터 횟수 규칙이 먼저예요. 한 사람에{" "}
          {MAX_AVOID}개까지, 누르면 바로 저장돼요. 운영자만 봐요.
        </p>
        <ErrorNote error={error} />
        {people.length === 0 && <p>참가자가 없어요.</p>}
        <ul className="list" aria-label="기피 라인 목록">
          {people.map((p) => {
            const list = listOf(p);
            const full = list.length >= MAX_AVOID;
            return (
              <li key={p.id} className="list-row static priority-row avoid-row">
                <span className="name">
                  {p.name}
                  {inDraft.has(p.id) && <span className="tag">이번 편성</span>}
                  {full && <span className="tag">{MAX_AVOID}개 모두 고름</span>}
                  {selfSet.has(p.id) && (
                    <span className="tag">본인이 정함</span>
                  )}
                </span>
                <span
                  className="segmented"
                  role="group"
                  aria-label={`${p.name}의 기피 라인`}
                >
                  {POSITIONS.map((position) => {
                    const on = list.includes(position);
                    const blocked = !on && full;
                    return (
                      <button
                        key={position}
                        type="button"
                        aria-label={`${p.name} ${POSITION_LABEL[position]} 기피`}
                        aria-pressed={on}
                        aria-disabled={blocked || undefined}
                        title={
                          blocked
                            ? `기피 라인은 ${MAX_AVOID}개까지예요.`
                            : undefined
                        }
                        disabled={p.id in pending}
                        onClick={() => void toggle(p, position)}
                      >
                        <PosLabel position={position} />
                      </button>
                    );
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <PrioritySide
        label="기피 라인 요약"
        rows={[
          {
            label: "기피 라인 정한 사람",
            count: people.filter((p) => listOf(p).length > 0).length,
          },
          ...POSITIONS.map((position) => ({
            label: `${POSITION_LABEL[position]} 기피`,
            count: people.filter((p) => listOf(p).includes(position)).length,
          })),
        ]}
        back={back}
      />
    </div>
  );
}
