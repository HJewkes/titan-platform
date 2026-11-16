const DAY_MS = 86_400_000;

/** Midnight UTC of the Monday that starts an ISO week such as `2026-W47`. */
function mondayOf(week: string): number {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (match === null) throw new Error(`not an ISO week: ${week}`);
  const jan4 = Date.UTC(Number(match[1]), 0, 4);
  const jan4Weekday = new Date(jan4).getUTCDay() || 7;
  return jan4 - (jan4Weekday - 1) * DAY_MS + (Number(match[2]) - 1) * 7 * DAY_MS;
}

function weekOf(ms: number): string {
  const at = new Date(ms);
  const weekday = at.getUTCDay() || 7;
  const thursday = ms + (4 - weekday) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function shiftWeek(week: string, by: number): string {
  return weekOf(mondayOf(week) + by * 7 * DAY_MS);
}

/** The Monday a week starts on, as YYYY-MM-DD. */
export function weekStart(week: string): string {
  return new Date(mondayOf(week)).toISOString().slice(0, 10);
}
