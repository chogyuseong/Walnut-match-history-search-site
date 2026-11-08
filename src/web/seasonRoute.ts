import type { Scope } from "../shared/stats";

// 시즌 요약 주소(#/season/...)의 읽고 쓰기. 화면(screens/SeasonSummary.tsx)과 따로 둔 것은
// 첫 화면 묶음(App.tsx)이 주소만 만들 때 시즌 요약 화면 코드까지 함께 받지 않게 하기 위해서다(화면은 지연 로딩).

/** 주소의 범위 부분: "시즌ID" 또는 "year/2026". */
export function seasonScopeFromRoute(parts: readonly (string | undefined)[]): Scope | null {
  const [first, second] = parts;
  if (first === "year" && second && /^\d{4}$/.test(second)) return { kind: "year", year: Number(second) };
  if (first && first !== "year") return { kind: "season", seasonId: first };
  return null;
}

/** 범위 → 주소의 범위 부분. */
export function seasonRoutePart(scope: Scope): string {
  return scope.kind === "year" ? `year/${scope.year}` : scope.kind === "season" ? scope.seasonId : "";
}
