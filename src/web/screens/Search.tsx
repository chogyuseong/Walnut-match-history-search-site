import { useEffect, useMemo, useRef, useState } from "react";
import { newestFirst } from "../../shared/insights";
import { parseDateQuery, textContains } from "../../shared/search";
import { localDate, matchesInScope, personRecords, searchByName, placementGamesOf } from "../../shared/stats";
import type { Snapshot } from "../../shared/types";
import { nameMap, rateText, rateTier, standingsOf } from "../format";
import { MatchCard, useExpectations } from "../matchCard";
import { addRecentSearch, loadRecentSearches, saveRecentSearches } from "../recentSearch";
import {
  pushHashQuery,
  readHashQuery,
  replaceHashQuery,
  SEARCH_FOCUS_EVENT,
  takeSearchFocus,
} from "../searchRoute";
import { RateBar, ScreenHead, StandingNote } from "../screenKit";

/** 경기 결과를 처음에 보여주는 수와 "더 보기"로 더 여는 수. */
const MATCH_PAGE = 20;

/** "2026-11-07" → "11월 7일"(올해가 아니면 "2025년 11월 7일"). */
function dateTitle(date: string, today: string): string {
  const md = `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;
  return date.slice(0, 4) === today.slice(0, 4) ? md : `${date.slice(0, 4)}년 ${md}`;
}

/**
 * 전적 검색. 운영자와 조회 링크가 같은 화면을 쓴다.
 * 범위 없이 모임 전체 누적 기록에서 찾고, 이름 일치도 순으로 보여준다(배치 여부로 순서를 바꾸지 않는다).
 * 이름은 공백·대소문자를 무시하고 초성("ㄱㅅ")으로도 찾는다(shared/search.ts).
 * 승률·경기 수·배치·칭호는 기록·개인 통계·그래프와 같은 누적 값이다.
 * "두 사람 비교"를 켜면 결과를 눌러 두 사람을 고르고 비교 화면으로 간다.
 *
 * 경기 검색: 질의가 날짜 꼴(11/7, 11월 7일, 2026-11-07 …)이면 그날(모임 시간대) 경기를, 아니면 메모에 질의가 든 경기를
 * 사람 결과 아래에 경기 카드로 보여준다. 미진행 취소 경기는 기록 화면처럼 빼고, 결과 미입력·제외 경기는 상태를 적어 보여준다.
 *
 * 질의는 주소(#/search?q=…)에 들어가 뒤로 가기·링크 공유가 된다(searchRoute.ts). 최근 검색어는 이 기기에 모임별로 남긴다.
 */
export function Search(props: {
  snapshot: Snapshot;
  openPerson: (id: string) => void;
  openCompare?: (a: string, b: string) => void;
  /** 경기 결과를 눌렀을 때 경기 상세로 간다. 없으면 경기 검색을 하지 않는다. */
  openMatch?: (id: string) => void;
}) {
  const { snapshot } = props;
  const groupId = snapshot.group.id;
  const tz = snapshot.group.timezone;
  const [query, setQuery] = useState(readHashQuery);
  const [comparing, setComparing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>(() => loadRecentSearches(groupId));
  const [matchShown, setMatchShown] = useState(MATCH_PAGE);
  const inputRef = useRef<HTMLInputElement>(null);
  const records = useMemo(() => personRecords(snapshot.matches), [snapshot]);
  const standing = useMemo(() => standingsOf(snapshot), [snapshot]);
  const placementGames = placementGamesOf(snapshot.group.settings);
  const nameOfId = useMemo(() => nameMap(snapshot), [snapshot]);
  const expectation = useExpectations(snapshot);
  // 확정된 경기가 있는 사람과, 아직 경기가 없는 활성 참가자를 모두 찾을 수 있다.
  const people = useMemo(
    () =>
      snapshot.participants
        .filter((p) => p.status === "active" || records.has(p.id))
        .map((p) => {
          const r = records.get(p.id);
          return { id: p.id, name: p.name, games: r?.games ?? 0, wins: r?.wins ?? 0, losses: r?.losses ?? 0 };
        }),
    [snapshot, records],
  );
  const blank = query.trim() === "";
  const found = blank ? [] : searchByName(people, query);
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "";

  // 경기 검색: 날짜 꼴이면 그날 경기, 아니면 메모. 미진행 취소는 기록 화면처럼 뺀다.
  const today = localDate(new Date().toISOString(), tz);
  const date = blank ? null : parseDateQuery(query, today);
  const matchHits = useMemo(() => {
    if (blank || !props.openMatch || comparing) return [];
    const visible = newestFirst(matchesInScope(snapshot, { kind: "all" }));
    if (date) return visible.filter((m) => localDate(m.playedAt, tz) === date);
    return visible.filter((m) => textContains(m.memo, query));
  }, [blank, props.openMatch, comparing, snapshot, date, tz, query]);

  // 입력하는 동안 주소의 질의를 고친다(기록은 쌓지 않는다).
  useEffect(() => {
    replaceHashQuery(query);
  }, [query]);

  // 뒤로 가기·최근 검색어로 주소가 바뀌면 입력 칸을 맞춘다.
  useEffect(() => {
    const onHash = () => {
      setQuery(readHashQuery());
      setMatchShown(MATCH_PAGE);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // 단축키 "/"로 들어왔으면 입력 칸에 초점(모바일에서 키보드가 튀지 않게 autoFocus는 쓰지 않는다).
  useEffect(() => {
    const focus = () => {
      if (takeSearchFocus()) inputRef.current?.focus();
    };
    focus();
    window.addEventListener(SEARCH_FOCUS_EVENT, focus);
    return () => window.removeEventListener(SEARCH_FOCUS_EVENT, focus);
  }, []);

  function remember(q: string) {
    const next = addRecentSearch(recent, q);
    if (next.length === recent.length && next.every((item, i) => item === recent[i])) return;
    setRecent(next);
    saveRecentSearches(groupId, next);
  }

  function choose(id: string) {
    if (!comparing) {
      remember(query);
      props.openPerson(id);
      return;
    }
    if (picked.includes(id)) {
      setPicked(picked.filter((p) => p !== id));
      return;
    }
    const next = [...picked, id];
    if (next.length === 2 && props.openCompare) {
      props.openCompare(next[0]!, next[1]!);
      return;
    }
    setPicked(next);
    setQuery("");
  }

  function searchAgain(q: string) {
    remember(q);
    setMatchShown(MATCH_PAGE);
    // 새 검색은 기록을 하나 쌓아 뒤로 가기로 앞 화면에 돌아올 수 있게 한다.
    pushHashQuery(q);
    setQuery(q);
  }

  const visibleMatches = matchHits.slice(0, matchShown);

  return (
    <div className="screen page-wide search-screen">
      <ScreenHead
        title="전적 검색"
        desc="모임의 전체 누적 기록에서 찾습니다. 배치와 칭호는 누적 기준이며, 결과 미입력·제외 경기는 세지 않습니다."
        actions={
          props.openCompare && (
          <button
            type="button"
            className="secondary"
            aria-pressed={comparing}
            onClick={() => {
              setComparing(!comparing);
              setPicked([]);
            }}
          >
            {comparing ? "비교 그만두기" : "두 사람 비교"}
          </button>
          )
        }
      />
      {comparing && (
        <p className="note" role="status">
          {picked.length === 0
            ? "비교할 첫 번째 사람을 찾아 누르세요."
            : `${nameOf(picked[0]!)} 님과 비교할 두 번째 사람을 찾아 누르세요.`}
        </p>
      )}
      <form
        role="search"
        aria-label="전적 검색"
        onSubmit={(event) => {
          event.preventDefault();
          if (!blank) remember(query);
          // 이름이 하나만 맞으면 바로 개인 통계로(비교 중이면 그 사람을 고른다).
          if (found.length === 1) choose(found[0]!.id);
        }}
      >
        <label>
          플레이어 이름
          <input
            ref={inputRef}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder="이름 일부만 넣어도 찾아요"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatchShown(MATCH_PAGE);
            }}
          />
        </label>
      </form>
      {props.openMatch && !comparing && (
        <p className="hint">초성(ㄱㅅ)으로도 찾고, 날짜(11/7)나 메모 글자를 넣으면 경기도 찾아요. 단축키: /</p>
      )}

      {blank && recent.length > 0 && !comparing && (
        <div className="recent-searches">
          <ul className="chips" aria-label="최근 검색어">
            {recent.map((q) => (
              <li key={q}>
                <button type="button" className="chip secondary" onClick={() => searchAgain(q)}>
                  {q}
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="link"
            aria-label="최근 검색어 지우기"
            onClick={() => {
              setRecent([]);
              saveRecentSearches(groupId, []);
            }}
          >
            지우기
          </button>
        </div>
      )}

      {people.length === 0 ? (
        <p className="hint">아직 참가자가 없어요. 경기를 저장하면 이름으로 전적을 찾을 수 있어요.</p>
      ) : blank ? (
        <p className="hint">참가자 {people.length}명 중에서 찾습니다.</p>
      ) : found.length === 0 ? (
        // 날짜로 경기를 찾을 때는 이름이 없다는 안내가 군더더기라 뺀다.
        date ? null : (
          <p className="hint">일치하는 이름이 없어요. 초성(ㄱㅅ)으로도 찾을 수 있어요.</p>
        )
      ) : (
        <section aria-label="검색 결과">
          <h2>검색 결과 {found.length}명</h2>
          <ul className="list list-card">
            {found.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={picked.includes(r.id) ? "list-row has-bar selected" : "list-row has-bar"}
                  aria-pressed={comparing ? picked.includes(r.id) : undefined}
                  onClick={() => choose(r.id)}
                >
                  <span className="name">{r.name}</span>
                  <span className="stat">
                    {r.games === 0 ? (
                      "확정된 경기 없음"
                    ) : (
                      <>
                        <span className={rateTier(r.wins, r.games)}>
                          {rateText(r.wins, r.games)}
                        </span>{" "}
                        · {r.wins}승 {r.losses}패 ({r.games}경기)
                      </>
                    )}
                    <br />
                    <span className="hint">
                      <StandingNote standing={standing.get(r.id)} placementGames={placementGames} compact />
                    </span>
                  </span>
                  {r.games > 0 && <RateBar wins={r.wins} games={r.games} small />}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {props.openMatch && !blank && !comparing && (date || matchHits.length > 0) && (
        // 영역 이름은 사람 결과("검색 결과")와 부분 일치로 겹치지 않게 따로 짓는다.
        <section aria-label="찾은 경기">
          <h2>
            {date ? `${dateTitle(date, today)} 경기` : "메모로 찾은 경기"} · {matchHits.length}경기
          </h2>
          {matchHits.length === 0 ? (
            <p className="hint">그날은 기록된 경기가 없어요.</p>
          ) : (
            <ul className="list match-cards">
              {visibleMatches.map((m) => (
                <MatchCard
                  key={m.id}
                  match={m}
                  nameOf={nameOfId}
                  timeZone={tz}
                  showDate
                  upset={expectation.get(m.id)?.upset}
                  onOpen={() => {
                    remember(query);
                    props.openMatch!(m.id);
                  }}
                  onPerson={(id) => {
                    remember(query);
                    props.openPerson(id);
                  }}
                />
              ))}
            </ul>
          )}
          {matchHits.length > visibleMatches.length && (
            <button type="button" className="link more" onClick={() => setMatchShown(matchShown + MATCH_PAGE)}>
              나머지 {matchHits.length - visibleMatches.length}경기 중{" "}
              {Math.min(MATCH_PAGE, matchHits.length - visibleMatches.length)}경기 더 보기
            </button>
          )}
        </section>
      )}
    </div>
  );
}
