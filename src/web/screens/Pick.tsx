import { useEffect, useMemo, useState } from "react";
import { applyTeams, createDraft, type DraftPerson } from "../../shared/draft";
import { nameKey, parseNameList } from "../../shared/names";
import { recommendTeams } from "../../shared/recommend";
import { formatDate } from "../format";
import { StickyAction } from "../ui";
import { go, useAppValue } from "../useApp";

const PICK_KEY = "naejeon.pick.v1";

function readPick(): DraftPerson[] {
  try {
    const value = JSON.parse(localStorage.getItem(PICK_KEY) ?? "[]") as DraftPerson[];
    return Array.isArray(value) ? value.filter((p) => typeof p?.key === "string") : [];
  } catch {
    return [];
  }
}

/** 화면 2 — 참가자 선택. 주요 행동은 "팀 짜기" 하나다. */
export function Pick() {
  const app = useAppValue();
  // 고르던 중에 화면을 닫아도 선택이 남도록 기기에 보관한다.
  const [selected, setSelected] = useState<DraftPerson[]>(readPick);
  const [text, setText] = useState("");
  const [messages, setMessages] = useState<string[]>([]);
  const [suggest, setSuggest] = useState<{ typed: string; existing: DraftPerson } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PICK_KEY, JSON.stringify(selected));
    } catch {
      // 보관하지 못해도 선택은 화면에 남아 있다.
    }
  }, [selected]);

  const known: DraftPerson[] = useMemo(
    () =>
      (app.snapshot?.participants ?? [])
        .filter((p) => p.status === "active")
        .map((p) => ({ key: `p:${p.id}`, name: p.name, participantId: p.id }))
        // 찾기 쉽도록 이름순으로 보여준다.
        .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    [app.snapshot],
  );

  const lastMatch = useMemo(() => {
    const matches = (app.snapshot?.matches ?? []).filter(
      (m) => m.source === "live" && m.state !== "canceled",
    );
    return matches.sort((a, b) => b.matchNo - a.matchNo)[0] ?? null;
  }, [app.snapshot]);

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
    let draft = createDraft(selected, {
      groupId: app.groupId,
      baseLiveVersion: app.snapshot?.group.liveVersion ?? null,
      seed,
      now,
    });
    // 실력 그룹을 지정한 사람이 있으면 기본 추천으로 팀을 나눈다.
    const groupOf = new Map((app.snapshot?.participants ?? []).map((p) => [p.id, p.skillGroup]));
    const recPeople = selected.map((p) => ({
      key: p.key,
      skillGroup: (p.participantId ? groupOf.get(p.participantId) : null) ?? null,
    }));
    if (app.snapshot && recPeople.some((p) => p.skillGroup !== null)) {
      const [best] = recommendTeams(recPeople, app.snapshot.group.settings.groupWeights, seed, 1);
      if (best) draft = { ...applyTeams(draft, best.teamA), previousSlots: null };
    }
    app.setDraft(draft);
    setSelected([]);
    go("/prep");
  }

  const query = nameKey(text);
  const visible = known.filter((p) => query === "" || nameKey(p.name).includes(query));
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

      {lastMatch && (
        <button
          type="button"
          className="secondary wide"
          onClick={() => {
            const ids = new Set(lastMatch.roster.map((r) => r.participantId));
            const people = known.filter((p) => p.participantId && ids.has(p.participantId));
            setSelected(people.slice(0, 10));
            setMessages(
              people.length < 10
                ? [`지난 참가자 중 ${people.length}명만 불러왔어요. 나머지는 보관된 참가자입니다.`]
                : ["지난 참가자를 불러왔어요. 오늘 참가자와 다르면 바꿔 주세요."],
            );
          }}
        >
          지난 참가자 불러오기 · {formatDate(lastMatch.playedAt, app.snapshot?.group.timezone)} 10명
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
          <h2>전체</h2>
          <ul className="list">
            {visible.map((p) => {
              const isSelected = selectedKeys.has(p.key);
              return (
                <li key={p.key}>
                  <button
                    type="button"
                    className={isSelected ? "list-row selected" : "list-row"}
                    aria-pressed={isSelected}
                    onClick={() => {
                      if (isSelected) setSelected(selected.filter((s) => s.key !== p.key));
                      else add([p], []);
                    }}
                  >
                    <span className="name">{isSelected ? "✓ " : ""}{p.name}</span>
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
