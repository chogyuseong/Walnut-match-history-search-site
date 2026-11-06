import { useEffect, useMemo, useState } from "react";
import { avoidMapFor } from "../../shared/avoid";
import { applyTeams, createDraft, type DraftPerson } from "../../shared/draft";
import { nameKey, parseNameList } from "../../shared/names";
import { participation } from "../../shared/insights";
import { lastMatchPeople } from "../../shared/lastPick";
import { remapPeople } from "../../shared/merge";
import { diversityFor, recommendTeams } from "../../shared/recommend";
import { latestSessionId } from "../../shared/stats";
import { formatDate } from "../format";
import { StickyAction } from "../ui";
import { JoinPanel, type JoinEntryView } from "../joinPanel";
import { go, pickKey, useAppValue } from "../useApp";

/** 고른 목록은 모임마다 따로 기억한다(모임 고르기). 예전 키(모임 구분 없음)에 남은 목록은 처음 연 모임으로 옮긴다. */
function readPick(groupId: string | null): DraftPerson[] {
  try {
    const key = pickKey(groupId);
    let raw = localStorage.getItem(key);
    if (raw === null && groupId) {
      raw = localStorage.getItem(pickKey(null));
      if (raw !== null) localStorage.removeItem(pickKey(null));
    }
    const value = JSON.parse(raw ?? "[]") as DraftPerson[];
    return Array.isArray(value) ? value.filter((p) => typeof p?.key === "string") : [];
  } catch {
    return [];
  }
}

/** 화면 2 — 참가자 선택. 주요 행동은 "팀 짜기" 하나다. */
export function Pick() {
  const app = useAppValue();
  // 고르던 중에 화면을 닫아도 선택이 남도록 기기에 보관한다.
  const [selected, setSelected] = useState<DraftPerson[]>(() => readPick(app.groupId));
  // 참가 신청에서 불러왔을 때 11번째부터의 신청자(대기). 표시만 하고 고르지 않는다.
  const [waiting, setWaiting] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [suggest, setSuggest] = useState<{ typed: string; existing: DraftPerson } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(pickKey(app.groupId), JSON.stringify(selected));
    } catch {
      // 보관하지 못해도 선택은 화면에 남아 있다.
    }
  }, [selected, app.groupId]);

  // 합치기 뒤 최신 상태를 받으면 화면에 든 고른 목록의 합쳐진 사람도 남은 사람으로 바꾼다
  // (기기 보관분은 useApp이 바꾸지만 이미 열린 화면의 상태는 여기서 바꿔야 한다).
  const participants = app.snapshot?.participants;
  useEffect(() => {
    if (!participants?.some((p) => p.mergedInto)) return;
    setSelected((current) => {
      const remapped = remapPeople(current, participants);
      return remapped.changed ? remapped.people : current;
    });
  }, [participants]);

  // 기본은 최근 참가 순(docs/P2 P2-11). 자주 나온 순·이름 순은 고를 수 있다.
  const [order, setOrder] = useState<"recent" | "often" | "name">("recent");
  // 사람별 누적 경기 수(확정 경기)와 마지막으로 나온 경기. 목록 정렬과 표시에 쓴다.
  const seen = useMemo(() => participation(app.snapshot?.matches ?? []), [app.snapshot]);
  const lastSession = useMemo(() => (app.snapshot ? latestSessionId(app.snapshot) : null), [app.snapshot]);
  const known: DraftPerson[] = useMemo(
    () =>
      (app.snapshot?.participants ?? [])
        .filter((p) => p.status === "active")
        .map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id })),
    [app.snapshot],
  );
  // 최근 참가 순: 마지막으로 나온 경기 → 누적 경기 수 → 이름.
  // 자주 나온 순: 누적 경기 수 → 최근에 나온 순 → 이름. 이름 순: 가나다.
  const ordered = useMemo(() => {
    const byName = (a: DraftPerson, b: DraftPerson) => a.name.localeCompare(b.name, "ko");
    if (order === "name") return [...known].sort(byName);
    return [...known].sort((a, b) => {
      const sa = seen.get(a.participantId!);
      const sb = seen.get(b.participantId!);
      const games = (sb?.games ?? 0) - (sa?.games ?? 0);
      const recent = (sb?.lastPlayedAt ?? "").localeCompare(sa?.lastPlayedAt ?? "");
      return (order === "recent" ? recent || games : games || recent) || byName(a, b);
    });
  }, [known, seen, order]);

  // 지난 참가자 불러오기(docs/P4 시나리오 15). 계산은 src/shared/lastPick.ts가 한다.
  const last = useMemo(
    () => (app.snapshot ? lastMatchPeople(app.snapshot.matches, app.snapshot.participants) : null),
    [app.snapshot],
  );

  const selectedKeys = new Set(selected.map((p) => p.key));
  const selectedNames = new Set(selected.map((p) => nameKey(p.name)));

  function add(people: DraftPerson[], notes: string[]) {
    const next = [...selected];
    const skipped: string[] = [];
    for (const person of people) {
      if (next.some((p) => p.key === person.key || nameKey(p.name) === nameKey(person.name))) {
        continue;
      }
      if (next.length >= 10) {
        skipped.push(person.name);
        continue;
      }
      next.push(person);
    }
    if (skipped.length > 0) {
      notes.push(
        `10명까지만 고를 수 있어 ${skipped.length}명(${skipped.join(", ")})은 넣지 않았습니다.`,
      );
    }
    setSelected(next);
    setMessages(notes);
  }

  function toPerson(name: string): DraftPerson {
    const existing = known.find((p) => nameKey(p.name) === nameKey(name));
    return existing ?? { key: `n:${nameKey(name)}`, name, participantId: null };
  }

  /** 참가 신청 불러오기: 신청 순으로 앞 10명을 고른 상태로 만들고(새 이름은 새 이름으로), 나머지는 대기로 보여준다. */
  function loadJoined(entries: readonly JoinEntryView[]) {
    const people: DraftPerson[] = [];
    const rest: string[] = [];
    for (const entry of entries) {
      const person: DraftPerson = entry.participantId
        ? (known.find((p) => p.participantId === entry.participantId) ?? {
            key: `p:${entry.participantId}`,
            name: entry.name,
            participantId: entry.participantId,
          })
        : toPerson(entry.name);
      if (people.some((p) => p.key === person.key || nameKey(p.name) === nameKey(person.name))) continue;
      if (people.length < 10) people.push(person);
      else rest.push(person.name);
    }
    setSelected(people);
    setWaiting(rest);
    setSuggest(null);
    setMessages([
      rest.length > 0
        ? `신청 순으로 ${people.length}명을 골랐어요. 대기 ${rest.length}명(${rest.join(", ")})은 넣지 않았어요. 손으로 바꿀 수 있어요.`
        : `신청자 ${people.length}명을 골랐어요. 손으로 바꿀 수 있어요.`,
    ]);
  }

  function submitText(raw: string, skipSuggest = false) {
    const parsed = parseNameList(raw);
    const notes: string[] = [];
    for (const name of parsed.duplicates) notes.push(`'${name}'가 두 번 있어요. 한 번만 넣었습니다.`);
    for (const name of parsed.tooLong) notes.push(`'${name}'는 20자를 넘어 넣지 않았습니다.`);
    if (parsed.names.length === 0) {
      setMessages(notes.length > 0 ? notes : ["이름을 입력해 주세요."]);
      return;
    }
    // 한 명을 새로 넣을 때 비슷한 기존 이름이 있으면 먼저 물어본다(중복 참가자 예방).
    if (!skipSuggest && parsed.names.length === 1) {
      const typed = parsed.names[0]!;
      const key = nameKey(typed);
      const exact = known.some((p) => nameKey(p.name) === key);
      const similar = known.find((p) => {
        const other = nameKey(p.name);
        return other !== key && key.length >= 2 && (other.includes(key) || key.includes(other));
      });
      if (!exact && similar && !selectedKeys.has(similar.key)) {
        setSuggest({ typed, existing: similar });
        return;
      }
    }
    for (const name of parsed.names) {
      if (selectedNames.has(nameKey(name))) notes.push(`'${name}'는 이미 선택돼 있어요.`);
    }
    add(parsed.names.map(toPerson), notes);
    setText("");
    setSuggest(null);
  }

  function buildTeams() {
    const now = new Date().toISOString();
    const seed = (Math.random() * 0xffffffff) >>> 0;
    // 기피 라인을 정한 사람은 처음 라인을 뽑을 때도 되도록 피한다(없으면 예전과 같다).
    const avoid = avoidMapFor(selected, app.snapshot?.participants);
    let draft = createDraft(selected, {
      groupId: app.groupId,
      baseLiveVersion: app.snapshot?.group.liveVersion ?? null,
      seed,
      now,
      avoid,
    });
    // 실력 그룹을 지정한 사람이 있으면 기본 추천으로 팀을 나눈다.
    const groupOf = new Map((app.snapshot?.participants ?? []).map((p) => [p.id, p.skillGroup]));
    const recPeople = selected.map((p) => ({
      key: p.key,
      skillGroup: (p.participantId ? groupOf.get(p.participantId) : null) ?? null,
    }));
    if (app.snapshot && recPeople.some((p) => p.skillGroup !== null)) {
      // 준비 화면의 추천과 같게 조합 다양성(모임 설정, 기본 켜짐)을 반영한다.
      const diversity = diversityFor(
        { matches: app.snapshot.matches, settings: app.snapshot.group.settings },
        selected,
      );
      const [best] = recommendTeams(
        recPeople,
        app.snapshot.group.settings.groupWeights,
        seed,
        1,
        [],
        diversity,
      );
      if (best) draft = { ...applyTeams(draft, best.teamA, avoid), previousSlots: null };
    }
    app.setDraft(draft);
    setSelected([]);
    go("/prep");
  }

  const query = nameKey(text);
  const visible = ordered.filter((p) => query === "" || nameKey(p.name).includes(query));
  const tz = app.snapshot?.group.timezone;
  const seenText = (id: string | null): string => {
    const s = id ? seen.get(id) : undefined;
    if (!s || s.lastPlayedAt === "") return "아직 경기 없음";
    const inLatest = lastSession !== null && s.lastSessionId === lastSession;
    const when = inLatest
      ? app.snapshot?.session?.id === lastSession
        ? "이번 세션 참가"
        : "지난 세션 참가"
      : `마지막 ${formatDate(s.lastPlayedAt, tz)}`;
    return `${s.games}경기 · ${when}`;
  };
  const missing = 10 - selected.length;

  return (
    <div className="screen">
      <header className="screen-head sticky-head">
        <button type="button" className="link" onClick={() => go("/")}>
          ← 오늘
        </button>
        <h1>참가자 고르기</h1>
        <strong className="count" aria-live="polite">
          {selected.length}/10
        </strong>
      </header>

      {app.me?.accountId && app.groupId && (
        <JoinPanel groupId={app.groupId} selectedKeys={selectedKeys} onLoad={loadJoined} />
      )}

      {waiting.length > 0 && (
        <p className="note" role="status">
          대기 {waiting.length}명: {waiting.join(", ")}
        </p>
      )}

      {last && (
        <button
          type="button"
          className="secondary wide"
          onClick={() => {
            setSelected(last.people);
            setMessages(
              last.missing > 0
                ? [
                    `지난 참가자 중 ${last.people.length}명만 불러왔어요. ${last.missing}명은 보관된 참가자라 뺐습니다.`,
                  ]
                : ["지난 참가자를 불러왔어요. 오늘 참가자와 다르면 바꿔 주세요."],
            );
          }}
        >
          지난 참가자 불러오기 · {formatDate(last.match.playedAt, app.snapshot?.group.timezone)}{" "}
          {last.people.length}명
        </button>
      )}

      <form
        className="name-form"
        onSubmit={(event) => {
          event.preventDefault();
          submitText(text);
        }}
      >
        <label htmlFor="name-input">이름 검색 또는 새 이름 입력</label>
        <div className="input-row">
          <textarea
            id="name-input"
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSuggest(null);
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (/[\n\t,]/.test(pasted)) {
                event.preventDefault();
                submitText(pasted, true);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submitText(text);
              }
            }}
            autoComplete="off"
          />
          <button type="submit" className="secondary">
            추가
          </button>
        </div>
        <p className="hint">여러 명은 줄바꿈으로 붙여 넣을 수 있어요.</p>
      </form>

      {suggest && (
        <p className="note" role="status">
          혹시 '{suggest.existing.name}'인가요?{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              add([suggest.existing], []);
              setText("");
              setSuggest(null);
            }}
          >
            '{suggest.existing.name}' 선택
          </button>{" "}
          <button type="button" className="link" onClick={() => submitText(suggest.typed, true)}>
            '{suggest.typed}' 새로 추가
          </button>
        </p>
      )}

      {messages.map((message) => (
        <p key={message} className="note" role="status">
          {message}
        </p>
      ))}

      <section aria-label="선택된 참가자">
        <h2>선택됨 {selected.length}</h2>
        {selected.length === 0 ? (
          <p className="hint">아직 고른 사람이 없어요.</p>
        ) : (
          <ul className="chips">
            {selected.map((p) => (
              <li key={p.key}>
                <button
                  type="button"
                  className="chip"
                  onClick={() => setSelected(selected.filter((s) => s.key !== p.key))}
                  aria-label={`${p.name} 빼기`}
                >
                  ✓ {p.name} <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {known.length > 0 && (
        <section aria-label="전체 참가자">
          <div className="section-head">
            <h2>전체 {known.length}명</h2>
            <div className="segmented pick-order" role="group" aria-label="참가자 정렬">
              <button type="button" aria-pressed={order === "recent"} onClick={() => setOrder("recent")}>
                최근 참가 순
              </button>
              <button type="button" aria-pressed={order === "often"} onClick={() => setOrder("often")}>
                자주 나온 순
              </button>
              <button type="button" aria-pressed={order === "name"} onClick={() => setOrder("name")}>
                이름 순
              </button>
            </div>
          </div>
          <ul className="list pick-grid">
            {visible.map((p) => {
              const isSelected = selectedKeys.has(p.key);
              return (
                <li key={p.key}>
                  <button
                    type="button"
                    className={isSelected ? "list-row pick-item selected" : "list-row pick-item"}
                    aria-pressed={isSelected}
                    onClick={() => {
                      if (isSelected) setSelected(selected.filter((s) => s.key !== p.key));
                      else add([p], []);
                    }}
                  >
                    <span className="pick-text">
                      <span className="name">{isSelected ? "✓ " : ""}{p.name}</span>
                      <span className="pick-meta">{seenText(p.participantId)}</span>
                    </span>
                    {isSelected && <span className="tag">선택됨</span>}
                  </button>
                </li>
              );
            })}
            {visible.length === 0 && <li className="hint">일치하는 참가자가 없어요.</li>}
          </ul>
        </section>
      )}

      <StickyAction>
        <button type="button" className="primary wide" disabled={missing !== 0} onClick={buildTeams}>
          팀 짜기 ({selected.length}/10)
        </button>
        {missing > 0 && <p className="hint center">{missing}명이 더 필요해요.</p>}
      </StickyAction>
    </div>
  );
}
