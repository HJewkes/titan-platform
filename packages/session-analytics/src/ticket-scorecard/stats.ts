const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Two decimals, so a sum read back from SQLite compares equal to the one computed in memory. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function hoursBetween(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  return round2((Date.parse(to) - Date.parse(from)) / MS_PER_HOUR);
}

/** The ISO 8601 week of an instant, in UTC: `2026-W45`. */
export function isoWeek(ts: string): string {
  const at = new Date(Date.parse(ts));
  const day = at.getUTCDay() === 0 ? 7 : at.getUTCDay();
  const thursday = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) + (4 - day) * MS_PER_DAY;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * MS_PER_DAY)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Nearest-rank quantile; null on an empty list. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(q * sorted.length) - 1);
  return sorted[index] ?? null;
}

/** `part / whole`, or null when nothing was measured. */
export function share(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}
