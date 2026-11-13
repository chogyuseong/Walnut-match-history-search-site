import { useMemo } from "react";
import { dateFindings } from "../shared/dateCheck";
import { nameKey } from "../shared/names";
import type { CrowdedDay, SheetMatch } from "../shared/sheetTable";

/**
 * 가져오기 미리보기의 날짜 경고(2026-11-08). 시트·기존 사이트 기록을 넣기 전에 줄 순서와 견줘
 * 연도가 밀린 묶음·같은 날짜와 시각에 같은 열 명·아직 오지 않은 날짜를 알려 준다(src/shared/dateCheck.ts 공용).
 * 막지는 않는다(연도가 없는 시트는 추정값이라 사람이 판단한다). 넣은 뒤에는 "날짜 점검"에서 한 번에 옮길 수 있다.
 * crowded는 한 날짜에 경기가 몰린 날(sheetTable.ts crowdedDays). 고르는 기준(넣을 경기가 그 날짜에 있을 때만)은
 * 부르는 쪽이 정해 넘긴다. 날짜 경고가 두 상자로 갈라지지 않게 같은 목록에 넣는다.
 */
export function ImportDateWarnings(props: { matches: readonly SheetMatch[]; crowded?: readonly CrowdedDay[] }) {
  const crowded = props.crowded ?? [];
  const findings = useMemo(
    () =>
      dateFindings(props.matches, (m) => ({
        key: String(m.line),
        order: m.line,
        at: Date.parse(`${m.date}T${m.time ?? "12:00"}:00Z`),
        people: [...m.teamA, ...m.teamB].map((p) => nameKey(p.name)),
      })),
    [props.matches],
  );
  const duplicates = findings.sameTime.filter((g) => g.sameRoster);
  const runs = findings.yearRuns.filter((r) => r.before !== null);
  if (runs.length === 0 && duplicates.length === 0 && findings.future.length === 0 && crowded.length === 0) return null;
  const where = (m: Pick<SheetMatch, "line" | "where">) => m.where ?? `${m.line}번째 줄`;
  return (
    <div className="note warn" role="status" aria-label="날짜 경고">
      <strong>날짜를 확인해 주세요.</strong>
      <ul className="problem-list">
        {runs.map((run, i) => (
          <li key={`run-${i}`}>
            {where(run.items[0]!)}부터 {where(run.items[run.items.length - 1]!)}까지 {run.items.length}경기(
            {run.items[0]!.date} ~ {run.items[run.items.length - 1]!.date})가 바로 앞 경기({run.before!.date})보다 반년
            넘게 과거예요. 해를 안 넘긴 것 같으면 연도를 고치거나, 넣은 뒤 "날짜 점검"에서 한 번에 옮기세요.
          </li>
        ))}
        {crowded.map((d) => (
          <li key={`crowded-${d.date}`}>
            {d.date}에 {d.count}경기가 몰려 있어요. 표에 날짜 칸이 비어 앞 날짜를 이어받았을 수 있으니 {where(d.first)}부터
            확인해 주세요. 맞는 기록이면 그대로 넣어도 돼요.
          </li>
        ))}
        {duplicates.map((g, i) => (
          <li key={`dup-${i}`}>
            {g.items.map(where).join(", ")}: 같은 날짜·시각에 같은 열 명이에요. 같은 경기를 두 번 적은 것일 수 있어요.
          </li>
        ))}
        {findings.future.length > 0 && (
          <li>아직 오지 않은 날짜 {findings.future.length}경기: {findings.future.map(where).join(", ")}</li>
        )}
      </ul>
    </div>
  );
}
