import { useState } from "react";
import type { Draft, DraftPerson } from "../../../shared/draft";
import { normalizePriority, priorityLabel, type Priority } from "../../../shared/priority";
import type { TeamCandidate } from "../../../shared/recommend";
import { matchesName } from "../../../shared/search";
import type { Team } from "../../../shared/types";
import { TEAM_MARK } from "../../format";
import { Dialog, useSearchJump } from "../../ui";
import { prepTeamName } from "./common";
import type { PrepEditing } from "./usePrepEditing";

// 팀 추천 창(2026-11-09 구조 수정): 후보마다 "머리글 + 적용 버튼 → 요약 칩 → 블루·레드 두 열 명단(이름 옆 티어)" 순서. 글줄로 나열하던 이전 구조는
// 어느 팀에 누가 있고 왜 균형인지 한눈에 안 들어와서 바꿨다. 티어는 운영자만 보는 값이라 priorityMap이 주는 대로만 쓴다.

interface Chip {
  label: string;
  value: string;
  tone?: "good";
}

/** 양 팀 모두 0인 칸(0:0)은 칩을 만들지 않는다. */
function candidateChips(candidate: TeamCandidate): Chip[] {
  const { sumDiff, topCount, bottomCount, unassignedCount, repeatPairs } = candidate;
  const versus = ([a, b]: readonly [number, number]) => `${a}:${b}`;
  const chips: Chip[] = [{ label: "티어 차", value: sumDiff === 0 ? "균형" : String(sumDiff), tone: sumDiff === 0 ? "good" : undefined }];
  if (topCount[0] + topCount[1] > 0) chips.push({ label: "1티어", value: versus(topCount) });
  if (bottomCount[0] + bottomCount[1] > 0) chips.push({ label: "5티어", value: versus(bottomCount) });
  if (unassignedCount[0] + unassignedCount[1] > 0) chips.push({ label: "미지정", value: versus(unassignedCount) });
  if (repeatPairs !== undefined)
    chips.push({ label: "최근 같은 팀 반복", value: `${repeatPairs}번`, tone: repeatPairs === 0 ? "good" : undefined });
  return chips;
}

/** 한 팀 명단: 티어 오름차순(1티어 먼저, 미지정 맨 뒤) → 이름순. 이름 옆에 "n티어" 알약(높을수록 밝은 색, 미지정은 점선). */
function TeamColumn(props: { team: Team; keys: readonly string[]; nameOf: (key: string) => string; tierOf: (key: string) => Priority }) {
  const { team, keys, nameOf, tierOf } = props;
  const sorted = [...keys].sort((a, b) => (tierOf(a) ?? 99) - (tierOf(b) ?? 99) || nameOf(a).localeCompare(nameOf(b), "ko"));
  return (
    <div className={`cand-team cand-team-${team === "A" ? "blue" : "red"}`}>
      <h4>
        <span aria-hidden="true">{TEAM_MARK[team]}</span> {prepTeamName(team)}
      </h4>
      <ul>
        {sorted.map((key) => {
          const tier = tierOf(key);
          return (
            <li key={key}>
              <span className="cand-name">{nameOf(key)}</span>
              <span className={tier === null ? "cand-tier none" : `cand-tier t${tier}`}>{priorityLabel(tier)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 팀 추천 창: 미리보기 후보 3개(조건이 충돌하면 충돌 조건 목록). 적용을 눌러야 편성이 바뀐다. */
export function RecommendDialog(props: { draft: Draft; candidates: TeamCandidate[]; edit: PrepEditing }) {
  const { draft, candidates, edit } = props;
  const { nameOf } = edit;
  // 티어는 창을 열 때 한 번만 읽는다(창 안에서 바뀌지 않는다).
  const priorities = edit.priorityMap();
  const tierOf = (key: string): Priority => normalizePriority(priorities[key]);
  return (
    <Dialog title="팀 추천" onClose={() => edit.setCandidates(null)}>
      {candidates.length === 0 ? (
        <>
          <p className="note warn" role="alert">
            조건을 모두 만족하는 편성이 없어요. 서로 충돌하는 조건을 지워 주세요.
          </p>
          <ul className="list">
            {(draft.constraints ?? []).map((constraint, index) => (
              <li key={`${constraint.a}|${constraint.b}`} className="list-row static">
                <span>
                  {nameOf(constraint.a)} · {nameOf(constraint.b)}{" "}
                  {constraint.kind === "same" ? "같은 팀" : "다른 팀"}
                </span>
                <button type="button" className="link" onClick={() => edit.dropConstraint(index, true)}>
                  조건 지우기
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="hint">미리보기입니다. 적용을 눌러야 편성이 바뀌고, 포지션은 새로 뽑습니다. 이름 옆 숫자는 티어예요.</p>
      )}
      {candidates.map((candidate, index) => (
        <section key={candidate.teamA.join(",")} className={index === 0 ? "candidate cand-main" : "candidate"}>
          <div className="cand-head">
            <h3>{index === 0 ? "기본 추천" : `다른 후보 ${index}`}</h3>
            <button
              type="button"
              className={index === 0 ? "primary" : "secondary"}
              onClick={() => edit.applyCandidate(candidate)}
            >
              적용
            </button>
          </div>
          <ul className="cand-chips" aria-label="균형 요약">
            {candidateChips(candidate).map((chip) => (
              <li key={chip.label} className={chip.tone ? `chip-${chip.tone}` : undefined}>
                <span className="chip-label">{chip.label}</span>
                <strong>{chip.value}</strong>
              </li>
            ))}
          </ul>
          <div className="cand-teams">
            <TeamColumn team="A" keys={candidate.teamA} nameOf={nameOf} tierOf={tierOf} />
            <TeamColumn team="B" keys={candidate.teamB} nameOf={nameOf} tierOf={tierOf} />
          </div>
          {/* 사유 문장은 화면 낭독기와 세부 확인용으로 작게 남긴다(칩과 같은 내용). */}
          <p className="hint cand-reason">{candidate.reason}</p>
        </section>
      ))}
    </Dialog>
  );
}

/** 다른 사람으로 교체 창: 편성과 대기자에 없는 활성 참가자 목록. */
export function ReplaceDialog(props: { selectedKey: string; others: DraftPerson[]; edit: PrepEditing }) {
  const { selectedKey, others, edit } = props;
  return (
    <Dialog title={`${edit.nameOf(selectedKey)} 대신 넣을 사람`} onClose={() => edit.setReplacing(false)}>
      <ul className="list">
        {others.map((p) => (
          <li key={p.key}>
            <button type="button" className="list-row" onClick={() => edit.replaceSelected(p)}>
              {p.name}
            </button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/**
 * 늦게 온 사람 창: 교체 목록과 같은 사람들(편성·쉬는 사람에 없는 활성 참가자)을 이름으로 찾는다.
 * 고른 사람은 쉬는 사람 끝에 들어간다. 아직 없는 새 이름은 참가자 고르기에서 넣는다(여기서 참가자를 만들지 않는다).
 */
export function LateDialog(props: { others: DraftPerson[]; onPick: (person: DraftPerson) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const lateJump = useSearchJump<HTMLDivElement>();
  // 공백·대소문자를 무시하고 초성("ㄱㅅ")으로도 찾는다(전적 검색과 같은 규칙).
  const shown = props.others
    .filter((p) => matchesName(p.name, query))
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  return (
    <Dialog title="늦게 온 사람" onClose={props.onClose}>
      <label>
        이름 찾기
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={lateJump.onSearchKey}
          enterKeyHint="search"
          autoComplete="off"
        />
      </label>
      <div ref={lateJump.results} tabIndex={-1} className="search-results">
        {shown.length === 0 ? (
          <p className="hint">
            {query.trim() === "" ? "넣을 수 있는 다른 참가자가 없어요." : "일치하는 이름이 없어요."} 처음 온 사람은 참가자 고르기에서
            이름을 넣어 주세요.
          </p>
        ) : (
          <ul className="list" aria-label="늦게 온 사람 후보">
            {shown.map((p) => (
              <li key={p.key}>
                <button type="button" className="list-row" onClick={() => props.onPick(p)}>
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}
