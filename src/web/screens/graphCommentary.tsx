// 그래프 분석의 "분석 코멘트" 카드와 문장마다의 근거 경기 접힘. 모임 전체(Graphs.tsx)와 고른 플레이어(graphProfile.tsx) 둘이 쓴다.
import { useMemo } from "react";
import type { Commentary, EvidenceGroup } from "../../shared/commentary";
import type { Snapshot } from "../../shared/types";
import { formatDate } from "../format";

/**
 * 분석 코멘트 카드: 총평 한 줄(굵게) + 문장 목록 + 코칭(우선순위 순 번호 목록, 최대 COACHING_MAX줄). 문장 앞 점 모양은 tone(좋음 골드 점 · 주의 골드 속 빈 점 · 보통 회색 점).
 * 코칭은 카드 안 1px 구분선 아래 "코칭" 라벨과 함께 둔다(카드 안 카드를 만들지 않는다).
 */
export function CommentaryCard(props: { notes: Commentary; snapshot: Snapshot; openMatch: (id: string) => void }) {
  const { summary, remarks, coaching } = props.notes;
  return (
    <section className="commentary" aria-label="분석 코멘트">
      <h2>분석 코멘트</h2>
      {remarks.length === 0 ? (
        <p className="commentary-empty">경기가 쌓이면 코멘트가 생겨요.</p>
      ) : (
        <>
          {summary && <p className="commentary-summary">{summary}</p>}
          <ul className="commentary-remarks">
            {remarks.map((r) => (
              <li key={r.text} className={`remark-${r.tone}`}>
                {r.text}
                {/* 근거는 title 풍선이 아니라 글로 둔다(터치 화면에서는 풍선이 뜨지 않는다). */}
                {r.basis && <span className="remark-basis">기준: {r.basis}</span>}
                {r.evidence && <EvidenceFold groups={r.evidence} snapshot={props.snapshot} openMatch={props.openMatch} />}
              </li>
            ))}
          </ul>
          {coaching && coaching.length > 0 && (
            <div className="commentary-coaching">
              <h3>코칭</h3>
              <ol>
                {coaching.map((tip) => (
                  <li key={tip.text}>
                    {tip.text}
                    {tip.basis && <span className="remark-basis">기준: {tip.basis}</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
      <p className="hint commentary-note">기록 수치를 규칙으로 읽어 쓴 평가와 제안이에요.</p>
    </section>
  );
}

/** 근거 경기 묶음마다 보이는 줄 수. 늘리면 문장 하나를 펼쳤을 때 카드가 길어져 다음 문장이 밀린다. */
const EVIDENCE_ROWS = 5;

/**
 * 코멘트 문장의 "근거 경기"(src/shared/commentary.ts Remark.evidence). 접어 두고, 펴면 묶음마다 EVIDENCE_ROWS줄과 나머지 수.
 * 숫자는 문장과 같은 경기에서 나온다. 특정 경기 탓으로 읽히지 않게 줄에는 날짜·경기 번호·결과만 두고 다른 사람 이름은 쓰지 않는다.
 */
function EvidenceFold(props: { groups: EvidenceGroup[]; snapshot: Snapshot; openMatch: (id: string) => void }) {
  const { snapshot } = props;
  const byId = useMemo(() => new Map(snapshot.matches.map((m) => [m.id, m])), [snapshot]);
  const total = props.groups.reduce((n, g) => n + g.matches.length, 0);
  if (total === 0) return null;
  return (
    <details className="help remark-evidence">
      <summary>근거 경기 {total}</summary>
      <div className="help-body">
        {props.groups.map((g) => (
          <div key={g.label}>
            <p className="evidence-label">
              {g.label} · {g.matches.length}경기
            </p>
            <ul className="evidence-rows">
              {g.matches.slice(0, EVIDENCE_ROWS).map((x) => {
                const m = byId.get(x.matchId);
                if (!m) return null;
                return (
                  <li key={x.matchId}>
                    <button type="button" className="link" onClick={() => props.openMatch(x.matchId)}>
                      {formatDate(m.playedAt, snapshot.group.timezone)} {m.matchNo}경기
                    </button>
                    <span>{x.note}</span>
                  </li>
                );
              })}
            </ul>
            {g.matches.length > EVIDENCE_ROWS && <p>외 {g.matches.length - EVIDENCE_ROWS}경기</p>}
          </div>
        ))}
      </div>
    </details>
  );
}
