import type { ReactNode } from "react";

export interface Column<Row> {
  header: string;
  /** Shown under the header, such as a metric's direction. */
  hint?: string;
  align?: "left" | "right";
  render: (row: Row) => ReactNode;
}

interface DataTableProps<Row> {
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  /** Indents a row, for a flattened hierarchy. */
  indent?: (row: Row) => number;
}

/**
 * SEAM (TD-33): a plain table until titan-design's filterable, virtualised Table lands; react-ui's
 * current Table is `custom/*`, so `candidate` in MATURITY.md, not Stable.
 */
export function DataTable<Row>({ caption, columns, rows, rowKey, indent }: DataTableProps<Row>): ReactNode {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-hairline">
          {columns.map((c) => (
            <th key={c.header} scope="col" className={`px-2 py-1 font-medium text-text-secondary ${c.align === "right" ? "text-right" : "text-left"}`}>
              {c.header}
              {c.hint && <span className="block text-xs font-normal text-text-tertiary">{c.hint}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} className="border-b border-hairline-subtle align-top">
            {columns.map((c, i) => (
              <td
                key={c.header}
                className={`px-2 py-1 ${c.align === "right" ? "text-right tabular-nums" : "text-left"}`}
                style={i === 0 && indent ? { paddingLeft: `${0.5 + indent(row) * 1.25}rem` } : undefined}
              >
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
