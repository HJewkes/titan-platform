import type { ReviewerDispatch } from "@titan-design/review-panel";

/** The account key a reviewer spawned with no `review.configDir` bills: agent-chat's own default. */
export const DEFAULT_ACCOUNT = "default";

/** The reviewer accounts, the first preferred, each a Claude config directory that spawns and bills on its own. */
export interface ReviewAccounts {
  /** `review.configDir` (or `DEFAULT_ACCOUNT`), then `review.fallbackConfigDirs` in order. */
  dirs: readonly string[];
  /** The dispatch whose spawns run under `configDir`; it shares the one roster. */
  dispatchUnder(configDir: string): ReviewerDispatch;
  /** Tells the repo's seat; a throw means nobody was told, so the next hold of that account tries again. */
  alert?: (repo: string, text: string) => Promise<void>;
}

const HOLD_PREFIX = "account-exhausted: ";

/** The furthest ahead a reset is believed: Claude Code's weekly window, plus a day of slack. */
export const MAX_RESET_AHEAD_MS = 8 * 24 * 60 * 60_000;
/** How long an account whose reset is not believed stays exhausted before a review tries it again. */
export const RECHECK_AFTER_MS = 60 * 60_000;

/** A reset that is missing, already past or beyond the cap is not believed, so the account is held an hour and then tried again, never longer. */
export const believedReset = (reset: number | undefined, now: number): number =>
  reset !== undefined && reset > now && reset - now <= MAX_RESET_AHEAD_MS ? reset : now + RECHECK_AFTER_MS;
const TASK_REF = "TP-1955";

const resetWords = (resetsAt: number | null): string => (resetsAt === null ? "an unknown reset" : new Date(resetsAt).toISOString());

/** The store hold's reason, which `titan-factory shepherd status` shows and the wait recognises as its own. */
export const accountHoldReason = (configDir: string, resetsAt: number | null): string => `${HOLD_PREFIX}${configDir} until ${resetWords(resetsAt)}; ${TASK_REF}`;

export function accountAlertText(configDir: string, resetsAt: number | null): string {
  const lift = resetsAt === null ? "Release a held run with `titan-factory shepherd release` once it has headroom." : "Held runs resume on their own after the reset.";
  return `Shepherd: the review account ${configDir} hit its usage limit and resets at ${resetWords(resetsAt)}. Reviews that would bill it are held (account-exhausted). ${lift}`;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** "resets Oct 10 at 6pm (America/Denver)", "resets 6:30pm (UTC)": an optional month and day, a 12-hour time, an IANA zone. */
const RESET = /\bresets?\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)\s]+)\)/i;

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The wall clock in `zone` at `at`; throws a RangeError for a zone Intl does not know. */
function wallClock(at: number, zone: string): WallTime & { second: number } {
  const format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const parts = Object.fromEntries(format.formatToParts(new Date(at)).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year!, month: parts.month! - 1, day: parts.day!, hour: parts.hour!, minute: parts.minute!, second: parts.second! };
}

const offsetAt = (at: number, zone: string): number => {
  const wall = wallClock(at, zone);
  return Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(at / 1000) * 1000;
};

/** The instant a wall time in `zone` names; the offset is read twice so a time just past a DST change lands right. */
function zonedEpoch(wall: WallTime, zone: string): number {
  const guess = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
  return guess - offsetAt(guess - offsetAt(guess, zone), zone);
}

/** A dated reset takes the year that puts it nearest `now`; a bare time is its next occurrence after `now`. */
function resolveReset(match: RegExpExecArray, now: number): number | undefined {
  const [, monthWord, day, hour, minute, meridiem, zone] = match;
  const hour24 = (Number(hour) % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0);
  const today = wallClock(now, zone!);
  const at = { hour: hour24, minute: Number(minute ?? 0) };
  if (monthWord === undefined) {
    const sameDay = zonedEpoch({ ...today, ...at }, zone!);
    return sameDay > now ? sameDay : zonedEpoch({ ...today, day: today.day + 1, ...at }, zone!);
  }
  const month = MONTHS.indexOf(monthWord.toLowerCase());
  if (month < 0) return undefined;
  const candidates = [today.year - 1, today.year, today.year + 1].map((year) => zonedEpoch({ year, month, day: Number(day), ...at }, zone!));
  return candidates.reduce((best, next) => (Math.abs(next - now) < Math.abs(best - now) ? next : best));
}

/** The reset a usage-limit notice names, as epoch ms; undefined when it names none this can read, so the hold stays until a release. */
export function parseLimitReset(notice: string, now: number): number | undefined {
  const match = RESET.exec(notice);
  if (!match) return undefined;
  try {
    return resolveReset(match, now);
  } catch {
    return undefined;
  }
}
