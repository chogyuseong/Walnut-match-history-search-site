// 시트 가져오기 화면(screens/SheetImport.tsx)이 읽어 들인 표(Loaded), 이 기기에 기억하는 열 맞춤, "건너뛸 줄" 글 읽기.
import { columnCount } from "../../../shared/csv";
import { hash64 } from "../../../shared/sheetFingerprint";
import { LAYOUTS, type SheetMapping } from "../../../shared/sheetMapping";
import type { SheetTab } from "../../../shared/sheetUrl";

const MAPPING_KEY = "naejeon.sheetMapping.v1:";

export interface Loaded {
  rows: string[][];
  kind: "sheet" | "paste";
  /** 시트 출처 열쇠(sheet:문서:gid). 붙여 넣기는 null. */
  sourceKey: string | null;
  title: string | null;
  /** 시트 문서의 탭 목록(주소에 탭 번호가 없었거나 탭 이름으로 읽었을 때). */
  tabs?: SheetTab[];
  /** 읽은 탭. */
  tab?: SheetTab;
}

export function parseRowList(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[,\s]+/)) {
    const range = /^(\d{1,6})(?:\s*[-~]\s*(\d{1,6}))?$/.exec(part.trim());
    if (!range) continue;
    const from = Number(range[1]);
    const to = Math.min(Number(range[2] ?? range[1]), from + 5000);
    for (let n = from; n <= to; n++) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function mappingKey(loaded: Loaded): string {
  if (loaded.sourceKey) return MAPPING_KEY + loaded.sourceKey;
  const first = loaded.rows.find((r) => r.some((c) => c.trim() !== "")) ?? [];
  return `${MAPPING_KEY}paste:${hash64(first.join("\u0001"))}`;
}

/** 이 기기에 기억한 열 맞춤. 표의 열 수와 맞지 않으면 버린다. */
export function storedMapping(loaded: Loaded): SheetMapping | null {
  try {
    const raw = localStorage.getItem(mappingKey(loaded));
    if (!raw) return null;
    const value = JSON.parse(raw) as SheetMapping;
    const cols = columnCount(loaded.rows);
    if (!LAYOUTS.includes(value.layout) || typeof value.columns !== "object") return null;
    if (Object.values(value.columns).some((c) => typeof c !== "number" || c < 0 || c >= cols)) return null;
    if (!Number.isInteger(value.headerRow) || !Array.isArray(value.skip)) return null;
    return {
      layout: value.layout,
      headerRow: value.headerRow,
      skip: value.skip.filter((n) => Number.isInteger(n)),
      columns: value.columns,
      lanesByOrder: value.lanesByOrder !== false,
      year: typeof value.year === "number" ? value.year : null,
    };
  } catch {
    return null;
  }
}

export function rememberMapping(loaded: Loaded, mapping: SheetMapping): void {
  try {
    localStorage.setItem(mappingKey(loaded), JSON.stringify(mapping));
  } catch {
    // 기기 저장소를 못 쓰면 기억하지 않는다(다음에 다시 맞추면 된다).
  }
}
