/**
 * 가져오기 미리보기의 "한 번 더 한 경기라면 골라서 넣기"(붙여 넣기 Import.tsx · 시트 가져오기 SheetImport.tsx).
 *
 * 같은 날 같은 10명·같은 결과의 경기는 지문이 같아서, 두 번째 경기만 따로 넣으면 "이미 들어간 경기"로 건너뛴다.
 * 내용만으로는 "같은 표를 다시 넣음"과 "한 번 더 한 경기"를 가를 수 없으므로 사람이 줄을 고르게 하고, 고른 줄은
 * 화면이 이미 쓰인 지문을 피한 다음 순번 지문(sheetTable nextFreeFingerprint)을 붙여 새 경기로 보낸다.
 */
export interface AgainRow {
  line: number;
  date: string;
  /** 줄 위치 설명(시트는 "3행" 같은 글, 붙여 넣기는 없음 → "n번째 줄"). */
  where?: string;
  winner: string;
  /** 팀 A 첫 사람 이름(줄을 알아보는 단서). */
  firstName: string;
}

export function ImportAgainPicker(props: {
  rows: readonly AgainRow[];
  picked: ReadonlySet<number>;
  disabled: boolean;
  onChange: (next: ReadonlySet<number>) => void;
}) {
  if (props.rows.length === 0) return null;
  return (
    <details className="import-again">
      <summary>한 번 더 한 경기라면 골라서 넣기</summary>
      <p className="hint">
        같은 날 같은 10명이 같은 결과로 한 경기 더 했다면, 그 줄을 골라 다른 경기로 넣으세요. 같은 표를 다시 넣은
        것이라면 고르지 마세요(같은 경기가 두 번 들어가요).
      </p>
      <ul className="list">
        {props.rows.map((r) => (
          <li key={r.line}>
            <label className="toggle">
              <input
                type="checkbox"
                checked={props.picked.has(r.line)}
                disabled={props.disabled}
                onChange={(e) => {
                  const next = new Set(props.picked);
                  if (e.target.checked) next.add(r.line);
                  else next.delete(r.line);
                  props.onChange(next);
                }}
              />{" "}
              {r.where ?? `${r.line}번째 줄`} · {r.date} · 팀 {r.winner} 승 · {r.firstName} 외 9명 · 다른 경기로 넣기
            </label>
          </li>
        ))}
      </ul>
    </details>
  );
}
