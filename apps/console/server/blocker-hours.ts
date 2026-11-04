/** TP-4388 decision 1: a single owner gate banners at 12 h, the same as a raised blocker. */
export const DEFAULT_BLOCKER_HOURS = 12;
const MAX_BLOCKER_HOURS = 720;

export interface BlockerConfig {
  /** Hours a blocker waits before the banner shows it, from `TITAN_CONSOLE_BLOCKER_HOURS`; absent in a hand-built config means 12. */
  blockerHours?: number;
}

/** `TITAN_CONSOLE_BLOCKER_HOURS` in whole hours, 1 to 30 days; a typo is refused, since a silent default would hide or flood the banner. */
export function blockerHoursFrom(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_BLOCKER_HOURS;
  const hours = Number(raw);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_BLOCKER_HOURS) throw new Error(`TITAN_CONSOLE_BLOCKER_HOURS must be whole hours from 1 to ${MAX_BLOCKER_HOURS}, got "${raw}"`);
  return hours;
}
