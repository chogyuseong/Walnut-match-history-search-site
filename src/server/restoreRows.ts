/**
 * 복원 행 넣기 부품: 행을 json_each용 JSON 묶음으로 나누기, 표마다 INSERT 문장 만들기, 새 모임 가져오기의 ID 대응표.
 * restore.ts buildRestorePlan이 쓴다. D1 한도(문자열·행 2MB)는 restore.ts 맨 위 설명 참고.
 */
import type { Env } from "./env";
import { invalid, utf8Bytes } from "./restoreChecks";

/** json_each로 넘기는 값 하나의 크기 상한. D1 문자열 한도 2MB보다 충분히 작게. */
export const CHUNK_BYTES = 512 * 1024;
/** 이보다 크면 점검 상태에서 여러 batch로 나눠 넣는다. RESTORE_BATCH_BYTES로 바꾼다. */
const DEFAULT_BATCH_BYTES = 1024 * 1024;

/**
 * 행들을 JSON 배열 문자열 묶음으로 나눈다. 묶음 하나의 UTF-8 바이트가 maxBytes를 넘지 않게 한다
 * (행 하나가 maxBytes보다 크면 그 행 혼자 한 묶음). 행 하나가 CHUNK_BYTES를 넘으면 D1 값 한도에 걸릴 수 있으므로
 * 아무것도 실행하기 전(계획 단계)에 거절한다.
 */
export function chunkRows(rows: unknown[][], maxBytes: number, table = "행"): { json: string; bytes: number }[] {
  const chunks: { json: string; bytes: number }[] = [];
  let current: string[] = [];
  let size = 2;
  for (const row of rows) {
    const text = JSON.stringify(row);
    const bytes = utf8Bytes(text);
    if (bytes + 2 > CHUNK_BYTES) {
      throw invalid([`${table} 한 행이 너무 큽니다(${bytes}바이트). 이 파일로는 복원할 수 없습니다.`]);
    }
    if (current.length > 0 && size + bytes + 1 > maxBytes) {
      chunks.push({ json: `[${current.join(",")}]`, bytes: size - 1 });
      current = [];
      size = 2;
    }
    current.push(text);
    size += bytes + 1;
  }
  if (current.length > 0) chunks.push({ json: `[${current.join(",")}]`, bytes: size - 1 });
  return chunks;
}

const col = (i: number) => `json_extract(value, '$[${i}]')`;

/** 표 하나의 행을 json_each로 넣는 문장들. 행 순서를 지킨다(변경 이력의 자동 번호 순서). */
export function insertStatements(
  env: Env,
  groupId: string,
  table: string,
  columns: string[],
  rows: unknown[][],
  maxBytes: number,
): { statement: D1PreparedStatement; bytes: number }[] {
  const select = columns.map((_, i) => col(i)).join(", ");
  const sql = `INSERT INTO ${table} (group_id, ${columns.join(", ")})
     SELECT ?1, ${select} FROM json_each(?2) ORDER BY CAST(key AS INTEGER)`;
  return chunkRows(rows, maxBytes, table).map(({ json, bytes }) => ({
    statement: env.DB.prepare(sql).bind(groupId, json),
    bytes,
  }));
}

/** ID 대응표: 새 모임으로 가져올 때 모든 ID를 새로 만든다. 같은 모임 복구는 그대로 쓴다. */
export function idMapper(remap: boolean): (id: string) => string {
  if (!remap) return (id) => id;
  const table = new Map<string, string>();
  return (id) => {
    let mapped = table.get(id);
    if (!mapped) {
      mapped = crypto.randomUUID();
      table.set(id, mapped);
    }
    return mapped;
  };
}

/**
 * 변경 이력의 항목에 든 참가자 ID도 새 ID로 바꾼다(새 모임으로 가져올 때).
 * 참가자 정정(participant), 포지션 정정(position:ID), 서포터 차례 정정(rotation:팀)의 값이 참가자 ID다.
 * 바꾸지 않으면 가져온 모임에서 이력의 이름이 비고, 합치기 이력을 묶어 보여주지 못한다.
 */
export function remapChanges(changes: string, map: (id: string) => string): string {
  let parsed: Record<string, { from: unknown; to: unknown }>;
  try {
    parsed = JSON.parse(changes) as Record<string, { from: unknown; to: unknown }>;
  } catch {
    return changes;
  }
  const id = (value: unknown) => (typeof value === "string" ? map(value) : value);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "participant" || key.startsWith("rotation:")) {
      out[key] = { from: id(value?.from), to: id(value?.to) };
    } else if (key.startsWith("position:")) {
      out[`position:${map(key.slice(9))}`] = value;
    } else {
      out[key] = value;
    }
  }
  return JSON.stringify(out);
}

export function batchBytesOf(env: Env): number {
  const n = Number(env.RESTORE_BATCH_BYTES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BATCH_BYTES;
}
