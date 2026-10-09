import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountProfile } from "../profile.js";
import type { UsageWindow } from "../usage.js";
import { readUsage, type UsageFileRead } from "../node/usage-file.js";
import type { CliContext } from "./context.js";
import { printableLabel } from "./report.js";

// The format ~/.claude/scripts/rate-limits.sh prints, so the status line can call this
// unchanged:
//   5h|weekly|5h_reset|weekly_reset|scoped|scoped_model|weekly_sev|scoped_sev|age_s
// then `other|<account>|5h|weekly|age_s|` for each other account with a reading.
export const UNKNOWN_LINE = "unknown|unknown|||||||";

interface Figures {
  five: UsageWindow;
  weekly: UsageWindow;
  age: number;
}

function figuresOf(configDir: string, now: number): Figures | null {
  let read: UsageFileRead | null;
  try {
    read = readUsage(configDir, { now });
  } catch {
    return null;
  }
  const five = read?.reading.rate_limits.five_hour;
  const weekly = read?.reading.rate_limits.seven_day;
  return read && five && weekly ? { five, weekly, age: read.ageSeconds } : null;
}

const whole = (window: UsageWindow): number => Math.floor(window.used_percentage);
const reset = (window: UsageWindow): string => (window.resets_at === undefined ? "" : String(window.resets_at));

function currentLine(figures: Figures | null): string {
  if (figures === null) return UNKNOWN_LINE;
  const { five, weekly, age } = figures;
  return `${whole(five)}|${whole(weekly)}|${reset(five)}|${reset(weekly)}|||||${age}`;
}

function realOrResolved(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function currentDir(context: CliContext): string {
  return context.env.CLAUDE_CONFIG_DIR || path.join(context.home ?? os.homedir(), ".claude");
}

function otherLine(profile: AccountProfile, now: number): string | null {
  const figures = figuresOf(profile.configDir, now);
  if (figures === null) return null;
  return `other|${printableLabel(profile.label)}|${whole(figures.five)}|${whole(figures.weekly)}|${figures.age}|`;
}

export function statuslineLines(profiles: readonly AccountProfile[], now: number, context: CliContext): string[] {
  const current = currentDir(context);
  const others = profiles.filter((profile) => realOrResolved(profile.configDir) !== realOrResolved(current));
  const lines = others.map((profile) => otherLine(profile, now)).filter((line) => line !== null);
  return [currentLine(figuresOf(current, now)), ...lines];
}
