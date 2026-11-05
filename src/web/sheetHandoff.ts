/**
 * 표 일괄 입력(Import.tsx)에서 붙여 넣은 글을 열 맞추기 화면(SheetImport.tsx)으로 넘긴다.
 * 화면을 옮겨도 다시 붙여 넣지 않게 메모리에만 잠깐 둔다(기기 저장소에는 남기지 않는다).
 */
let pending: string | null = null;

export function handOffPaste(text: string): void {
  pending = text;
}

export function takePastedText(): string | null {
  const text = pending;
  pending = null;
  return text;
}

/** 시트 가져오기 화면의 주소 칸에 넣은 기존 사이트(Apps Script) 주소를 기존 사이트 가져오기 화면으로 넘긴다. */
let pendingLegacy: string | null = null;

export function handOffLegacyUrl(url: string): void {
  pendingLegacy = url;
}

export function takeLegacyUrl(): string | null {
  const url = pendingLegacy;
  pendingLegacy = null;
  return url;
}
