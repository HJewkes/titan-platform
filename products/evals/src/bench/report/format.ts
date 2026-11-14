import type { RateCell, Range } from "./stats.js";

export const DASH = "—";

export const pct = (value: number | null): string => (value === null ? DASH : `${(value * 100).toFixed(0)}%`);

const signedPts = (value: number | null): string => (value === null ? DASH : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(0)}`);

export const usd = (value: number | null): string => (value === null ? DASH : `$${value.toFixed(3)}`);

export const num = (value: number | null, digits = 2): string => (value === null ? DASH : value.toFixed(digits));

export const pValue = (value: number | null): string => (value === null ? DASH : value < 0.001 ? "<0.001" : value.toFixed(3));

export function rate(cell: RateCell | null | undefined): string {
  if (cell === null || cell === undefined) return DASH;
  return `${cell.successes}/${cell.n} ${pct(cell.rate)} [${pct(cell.lower)}–${pct(cell.upper)}]`;
}

export const range = (value: Range): string => (value.estimate === null ? DASH : `${usd(value.estimate)} [${usd(value.lower)}–${value.upper === null ? "unbounded" : usd(value.upper)}]`);

export const ptsInterval = (delta: number | null, lower: number | null, upper: number | null): string => `${signedPts(delta)} [${signedPts(lower)}, ${signedPts(upper)}]`;

const escapeCell = (text: string): string => text.replaceAll("|", "\\|");

export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

export const placeholder = (what: string): string => `<!-- coordinator: ${what} -->`;
