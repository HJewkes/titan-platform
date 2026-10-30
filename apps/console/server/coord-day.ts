import path from "node:path";
import { z } from "zod";

/** Epoch ms bounds of one coordinator day: it starts at the configured local time, not at midnight. */
export interface DayWindow {
  /** The local calendar date the window starts on, `YYYY-MM-DD`. */
  date: string;
  from: number;
  to: number;
}

/** One `pool-readings.jsonl` row, with its unix seconds turned into epoch ms. */
export interface PoolReading {
  ts: number;
  sevenDay: number;
  /** Epoch ms the reading's seven-day window resets. */
  resetsAt: number;
  /** The window had passed, so `sevenDay` is an assumed 0 and no measurement. */
  rolled?: true;
}

export interface CoordinatorDayConfig {
  /** `HH:MM` local time a coordinator day starts at, from `TITAN_CONSOLE_DAY_START`; absent in a hand-built config means 07:00. */
  dayStart?: string;
  /** Where the once-a-day summaries of what shipped are written and read; defaults to `<stateDir>/shipped`. */
  shippedDir?: string;
}

export const DEFAULT_DAY_START = "07:00";
const DAY_START = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WINDOW_MS = 7 * 86_400_000;

/** `TITAN_CONSOLE_DAY_START` as `HH:MM`; a typo is refused, since a silent default would move every day's figures. */
export function dayStartFrom(raw: string | undefined): string {
  if (raw === undefined || raw === "") return DEFAULT_DAY_START;
  if (!DAY_START.test(raw)) throw new Error(`TITAN_CONSOLE_DAY_START must be HH:MM from 00:00 to 23:59, got "${raw}"`);
  return raw;
}

export function coordinatorDayFrom(env: NodeJS.ProcessEnv, stateDir: string): Required<CoordinatorDayConfig> {
  return { dayStart: dayStartFrom(env.TITAN_CONSOLE_DAY_START), shippedDir: path.join(stateDir, "shipped") };
}

export const isCalendarDate = (value: string): boolean => {
  const match = DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};

/** The `date` argument every coordinator read takes: absent means the day holding now. */
export const dateArg = z.string().refine(isCalendarDate, "a date as YYYY-MM-DD").optional();

const pad = (value: number): string => String(value).padStart(2, "0");
const dateLabel = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** Local wall-clock constructors, so a day that crosses a DST change still starts at the same local time. */
function startOn(year: number, month: number, day: number, dayStart: string): Date {
  return new Date(year, month, day, Number(dayStart.slice(0, 2)), Number(dayStart.slice(3, 5)));
}

/** The window holding `now`, or the one starting on `date` when given. */
export function dayWindow(now: number, dayStart: string, date?: string): DayWindow {
  const base = date === undefined ? new Date(now) : new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  let from = startOn(base.getFullYear(), base.getMonth(), base.getDate(), dayStart);
  if (date === undefined && from.getTime() > now) from = startOn(base.getFullYear(), base.getMonth(), base.getDate() - 1, dayStart);
  const to = startOn(from.getFullYear(), from.getMonth(), from.getDate() + 1, dayStart);
  return { date: dateLabel(from), from: from.getTime(), to: to.getTime() };
}

/**
 * What the pool had used when the day began, and what it has used since. A window that reset after the day began
 * carries nothing over, and a reading from before the current window belongs to last week's count.
 */
export function dayUsage(readings: readonly PoolReading[], current: number, window: DayWindow, resetsAt: number): { beforeToday: number; today: number } {
  const windowStart = resetsAt - WINDOW_MS;
  const before = windowStart > window.from ? undefined : readings.filter((row) => !row.rolled && row.ts <= window.from && row.ts >= windowStart).sort((a, b) => b.ts - a.ts)[0];
  const beforeToday = before?.sevenDay ?? 0;
  return { beforeToday, today: Math.max(0, current - beforeToday) };
}

/** The seven-day figure that spends the day's allowance; null when no per-day limit is set. */
export const perDayGuard = (beforeToday: number, perDayPoints: number | null): number | null => (perDayPoints === null ? null : beforeToday + perDayPoints);
