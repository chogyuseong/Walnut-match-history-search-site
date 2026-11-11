import { Fragment, type ReactNode } from "react";
import { SortArrow, type SortState } from "./screenKit";

// 표(DataTable)는 첫 화면 묶음(ui.tsx는 App.tsx가 부른다)에 들어가지 않게 따로 둔다. 쓰는 화면(요약·챔피언 티어)이 모두 지연 로딩이다.

export interface TableColumn<T> {
  key: string;
  label: ReactNode;
  /** 숫자 열: 오른쪽 정렬, 고정폭 숫자. */
  num?: boolean;
  sortable?: boolean;
  /** 좁은 화면(768px 미만)에서 숨길 열. 가로 스크롤 대신 중요한 열만 남긴다. */
  wideOnly?: boolean;
  className?: string;
  cell: (row: T) => ReactNode;
}

/**
 * 표(진짜 table). 머리 줄은 올린 면, 숫자 열은 오른쪽 정렬, 지금 정렬 열은 머리에 밑줄과 aria-sort.
 * 정렬 열 머리는 버튼이라 Tab·Enter로 정렬할 수 있다. 정렬 계산은 부르는 쪽이 한다(sort·onSort):
 * 표본이 적은 사람을 뒤로 미는 것처럼 화면마다 규칙이 달라서다.
 * onRowClick이 있으면 줄 아무 데나 눌러도 열린다(마우스 편의). 키보드는 줄 안의 버튼(첫 칸 등)으로 연다.
 * 줄 안 다른 버튼(이름 → 개인 통계)은 stopPropagation으로 줄 열기와 겹치지 않게 한다.
 * expanded가 무언가를 돌려주면 그 줄 바로 밑에 전체 폭 줄을 하나 더 둔다(챔피언 티어의 펼친 줄). 여닫는 상태는 부르는 쪽이 갖는다.
 */
export function DataTable<T>(props: {
  caption: string;
  columns: readonly TableColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  sort?: SortState<string>;
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  rowClass?: (row: T) => string;
  expanded?: (row: T) => ReactNode;
  className?: string;
}) {
  const { sort } = props;
  const colClass = (col: TableColumn<T>) =>
    [col.className ?? "", col.num ? "num" : "", col.wideOnly ? "wide-only" : "", sort?.key === col.key ? "is-sorted" : ""]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <table className={props.className ? `data-table ${props.className}` : "data-table"}>
      <caption className="sr-only">{props.caption}</caption>
      <thead>
        <tr>
          {props.columns.map((col) => {
            const active = sort?.key === col.key;
            return (
              <th
                key={col.key}
                scope="col"
                className={colClass(col)}
                aria-sort={col.sortable ? (active ? (sort!.dir === "desc" ? "descending" : "ascending") : "none") : undefined}
              >
                {col.sortable && props.onSort ? (
                  <button type="button" className={active ? "dt-sort is-active" : "dt-sort"} onClick={() => props.onSort!(col.key)}>
                    {col.label}
                    <SortArrow active={active} dir={sort?.dir ?? "desc"} />
                  </button>
                ) : (
                  col.label
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row) => {
          const extra = props.expanded?.(row);
          return (
            <Fragment key={props.rowKey(row)}>
              <tr
                className={[props.onRowClick ? "is-clickable" : "", props.rowClass?.(row) ?? ""].filter(Boolean).join(" ") || undefined}
                onClick={props.onRowClick ? () => props.onRowClick!(row) : undefined}
              >
                {props.columns.map((col) => (
                  <td key={col.key} className={colClass(col)}>
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
              {extra && (
                <tr className="dt-expand">
                  {/* 좁은 화면에서 숨은 열이 있어도 colSpan이 남는 칸까지 덮는다. */}
                  <td colSpan={props.columns.length}>{extra}</td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
