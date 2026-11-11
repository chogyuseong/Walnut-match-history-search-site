import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { championName, championUsage, searchChampions } from "../shared/champions";
import { TEAMS, type MatchView } from "../shared/types";
import { ChampionPortrait } from "./championPortrait";
import { POSITION_LABEL, TEAM_MARK, teamName, teamRoster } from "./format";
import { PosLabel } from "./screenKit";
import { scrollBehavior } from "./ui";

/**
 * 경기 명단 10명의 챔피언 고르기(2026-11-10, migrations/0025). 결과 입력 창(접힌 영역)과 경기 상세의 챔피언 수정이 함께 쓴다.
 * 챔피언 목록이 첫 화면 묶음에 들어가지 않게 결과 입력 창은 이 파일을 지연 로딩한다(src/web/lazyScreens.ts ChampionFields).
 *
 * value는 { 참가자 ID: 챔피언 키 }이고 고른 사람만 들어 있다. 일부만 채워도 된다.
 */
export function ChampionFields(props: {
  match: MatchView;
  nameOf: (id: string) => string;
  /** 자주 쓴 챔피언을 셀 경기들(보통 스냅숏의 전체 경기). */
  history: readonly MatchView[];
  value: Readonly<Record<string, string>>;
  onChange: (next: Record<string, string>) => void;
}) {
  const { match, nameOf, value } = props;
  const order = TEAMS.flatMap((team) => teamRoster(match, team));
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const usageById = useMemo(
    () => new Map(match.roster.map((r) => [r.participantId, championUsage(props.history, r.participantId)])),
    [match.roster, props.history],
  );

  function set(participantId: string, key: string | null) {
    const next = { ...value };
    if (key === null) delete next[participantId];
    else next[participantId] = key;
    props.onChange(next);
  }

  return (
    <div className="champ-fields">
      <p className="hint">이름 일부·초성(ㅇㄹ → 아리)·영어로 찾아요. 비워 둔 사람은 기록하지 않아요.</p>
      {TEAMS.map((team) => (
        <fieldset key={team} className="champ-team">
          <legend>
            <span aria-hidden="true">{TEAM_MARK[team]}</span> {teamName(team, match.teamASide)}
          </legend>
          {teamRoster(match, team).map((entry) => {
            const index = order.indexOf(entry);
            const taken = new Set(
              Object.entries(value)
                .filter(([id]) => id !== entry.participantId)
                .map(([, key]) => key),
            );
            const label = `${entry.position ? `${POSITION_LABEL[entry.position]} ` : ""}${nameOf(entry.participantId)}`;
            return (
              <div key={entry.participantId} className="champ-row">
                <span className="champ-who">
                  <PosLabel position={entry.position} />
                  <span className="name" title={nameOf(entry.participantId)}>
                    {nameOf(entry.participantId)}
                  </span>
                </span>
                <ChampionCombobox
                  label={label}
                  value={value[entry.participantId] ?? null}
                  usage={usageById.get(entry.participantId)!}
                  taken={taken}
                  inputRef={(el) => {
                    inputs.current[index] = el;
                  }}
                  onPick={(key) => {
                    set(entry.participantId, key);
                    // 고르면 다음 사람 칸으로 넘어간다(화면 키보드를 닫지 않고 이어서 고르게).
                    inputs.current[index + 1]?.focus();
                  }}
                  onClear={() => set(entry.participantId, null)}
                />
              </div>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

/**
 * 챔피언 한 칸. WAI-ARIA combobox(목록형) 패턴: 초점은 입력 칸에 두고 위/아래로 목록의 항목을 가리키며(aria-activedescendant)
 * Enter로 고르고 Esc로 목록을 닫는다. 목록은 떠 있는 상자가 아니라 칸 바로 밑에 끼워 넣어(문서 흐름) 좁은 화면에서
 * 창 밖으로 나가지 않는다.
 */
function ChampionCombobox(props: {
  label: string;
  value: string | null;
  usage: ReadonlyMap<string, number>;
  taken: ReadonlySet<string>;
  inputRef: (el: HTMLInputElement | null) => void;
  onPick: (key: string) => void;
  onClear: () => void;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-opt-${i}`;
  const row = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // null이면 입력 칸에 고른 챔피언 이름을 보여 준다. 칸에 초점이 오면 빈 검색어로 바꿔 바로 칠 수 있게 한다.
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const open = query !== null;
  const options = useMemo(
    () => (open ? searchChampions(query, { usage: props.usage, taken: props.taken }) : []),
    [open, query, props.usage, props.taken],
  );

  function moveTo(index: number) {
    setActive(index);
    list.current?.querySelector(`#${CSS.escape(optionId(index))}`)?.scrollIntoView({ block: "nearest" });
  }

  function pick(index: number) {
    const option = options[index];
    if (!option) return;
    setQuery(null);
    props.onPick(option.champion.key);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setQuery("");
        setActive(0);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      if (options.length > 0) moveTo((active + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      // 창 안의 다른 버튼(저장)이 Enter로 눌리지 않게 막는다.
      event.preventDefault();
      // 한글 조합을 확정하는 Enter는 고르기로 치지 않는다. 일부 브라우저는 이 Enter를 keydown으로 두 번 내보내서,
      // 걸러 내지 않으면 초점이 넘어간 다음 사람 칸에 목록 첫 챔피언이 들어간다.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (open) pick(active);
    } else if (event.key === "Escape" && open) {
      // 목록만 닫는다. 위로 올려 보내면 결과 입력 창(Dialog)까지 닫힌다.
      event.stopPropagation();
      setQuery(null);
    }
  }

  return (
    <>
      <div className="champ-input" ref={row}>
        <input
          ref={props.inputRef}
          type="text"
          role="combobox"
          aria-label={`${props.label} 챔피언`}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? optionId(active) : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="done"
          placeholder={props.value ? championName(props.value) : "챔피언 찾기"}
          value={query ?? (props.value ? championName(props.value) : "")}
          onFocus={() => {
            setQuery("");
            setActive(0);
            // 폰에서는 화면 키보드가 올라온 뒤 이 칸을 창 위쪽으로 올려 목록이 키보드에 가리지 않게 한다.
            if (window.matchMedia("(max-width: 599px)").matches) {
              setTimeout(() => row.current?.scrollIntoView({ block: "start", behavior: scrollBehavior() }), 300);
            }
          }}
          onBlur={() => setQuery(null)}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {props.value && (
          <button
            type="button"
            className="link champ-clear"
            aria-label={`${props.label} 챔피언 지우기`}
            onClick={props.onClear}
          >
            지우기
          </button>
        )}
      </div>
      {open && (
        <ul ref={list} id={listId} role="listbox" aria-label={`${props.label} 챔피언 목록`} className="champ-list">
          {options.length === 0 && <li className="hint champ-empty">맞는 챔피언이 없어요.</li>}
          {options.map((option, i) => (
            <li
              key={option.champion.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={option.taken ? "champ-option taken" : "champ-option"}
              // 누르는 동안 입력 칸의 초점이 빠지면(blur) 목록이 먼저 닫혀 고르지 못한다.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span className="champ-option-name">
                <ChampionPortrait championKey={option.champion.key} size={28} />
                {option.champion.name}
              </span>
              {option.taken ? (
                <span className="champ-note">다른 사람이 고름</span>
              ) : option.used > 0 ? (
                <span className="champ-note">{option.used}판</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
