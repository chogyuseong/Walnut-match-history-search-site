/**
 * 쉼표(CSV)·탭(TSV)으로 나눈 글을 표(문자열 2차원 배열)로 읽는다.
 *
 * - 큰따옴표로 감싼 칸 안의 쉼표·탭·줄바꿈은 칸의 일부다. 칸 안의 큰따옴표는 두 번 써서 나타낸다("").
 * - 맨 앞의 BOM(U+FEFF)은 버린다. 줄 끝은 \r\n, \n, \r 모두 받는다.
 * - 구글 시트의 CSV 내보내기와 시트에서 복사해 붙여 넣은 글(TSV)을 같은 표 모델로 만든다.
 * - 줄(행) 번호는 1부터 센다. 빈 줄도 한 줄로 센다(시트의 행 번호와 맞추기 위해).
 *   다만 글 맨 끝의 빈 줄(마지막 줄바꿈 뒤)은 줄로 세지 않는다.
 */

export type Delimiter = "," | "\t";

/** 첫 번째 내용 있는 줄에 탭이 있으면 탭, 아니면 쉼표로 본다(따옴표 안은 보지 않는다). */
export function detectDelimiter(text: string): Delimiter {
  let inQuotes = false;
  let sawContent = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === "\t") return "\t";
    else if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (sawContent) return ",";
    } else if (ch.trim() !== "") sawContent = true;
  }
  return ",";
}

export function parseDelimited(text: string, delimiter: Delimiter = detectDelimiter(text)): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  // 칸이 따옴표로 시작했는지. 따옴표는 칸 맨 앞에서만 특별한 뜻을 가진다(시트가 만드는 형식).
  let cellStarted = false;
  let i = 0;
  const n = source.length;

  const endCell = () => {
    row.push(cell);
    cell = "";
    cellStarted = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const ch = source[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && !cellStarted && cell === "") {
      inQuotes = true;
      cellStarted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endCell();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      endRow();
      i += ch === "\r" && source[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch;
    cellStarted = true;
    i += 1;
  }
  // 마지막 줄: 줄바꿈 없이 끝났거나 따옴표가 닫히지 않았을 때도 남은 내용을 넣는다.
  if (cell !== "" || row.length > 0 || cellStarted) endRow();
  return rows;
}

/** 모든 칸이 비어 있는(공백만 있는) 줄인지. */
export function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

/** 표의 열 수(가장 긴 줄 기준). 끝의 빈 열은 세지 않는다. */
export function columnCount(rows: readonly (readonly string[])[]): number {
  let max = 0;
  for (const row of rows) {
    let last = row.length - 1;
    while (last >= 0 && row[last]!.trim() === "") last -= 1;
    max = Math.max(max, last + 1);
  }
  return max;
}
