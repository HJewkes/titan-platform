import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountUsage, AccountWindow } from "../merge.js";
import { accountLabel } from "../profile.js";
import { readAccountGroup, type ReadAccountsOptions } from "../node/accounts.js";
import type { CliContext } from "./context.js";
import { printableLabel } from "./report.js";

// The format ~/.claude/scripts/rate-limits.sh prints, so the status line can call this
// unchanged:
//   5h|weekly|5h_reset|weekly_reset|scoped|scoped_model|weekly_sev|scoped_sev|age_s
// then `other|<account>|5h|weekly|age_s|` for each other account with a reading.
export const UNKNOWN_LINE = "unknown|unknown|||||||";

interface Figures {
  five: AccountWindow | undefined;
  weekly: AccountWindow;
  scoped: AccountUsage["scoped"];
  age: number;
}

// A rolled window has read nothing since its reset, so the line shows it as absent; only
// seven_day is required, since the usage response stopped carrying five_hour on 2026-10-31.
const open = (window: AccountWindow | undefined): AccountWindow | undefined => (window?.rolled ? undefined : window);

function figuresOf(row: AccountUsage | undefined): Figures | null {
  const weekly = open(row?.windows.seven_day);
  if (row === undefined || weekly === undefined || row.age_seconds === null) return null;
  return { five: open(row.windows.five_hour), weekly, scoped: row.scoped, age: row.age_seconds };
}

const whole = (window: AccountWindow | undefined): string => (window === undefined ? "" : String(Math.floor(window.used_pct)));
const reset = (window: AccountWindow | undefined): string => (window?.resets_at === undefined ? "" : String(window.resets_at));

function currentLine(figures: Figures | null): string {
  if (figures === null) return UNKNOWN_LINE;
  const { five, weekly, scoped, age } = figures;
  const scopedFields = [scoped === undefined ? "" : Math.floor(scoped.used_pct), scoped?.model ?? "", weekly.severity ?? "", scoped?.severity ?? ""];
  return [whole(five), whole(weekly), reset(five), reset(weekly), ...scopedFields, age].join("|");
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

function otherLine(row: AccountUsage): string | null {
  const figures = figuresOf(row);
  if (figures === null) return null;
  return `other|${printableLabel(row.account)}|${whole(figures.five)}|${whole(figures.weekly)}|${figures.age}|`;
}

// The current dir may lie outside the scan, so it is read as a login of its own then.
export function statuslineLines(rows: readonly AccountUsage[], options: ReadAccountsOptions, context: CliContext): string[] {
  const current = realOrResolved(currentDir(context));
  const holds = (row: AccountUsage): boolean => row.config_dirs.some((dir) => realOrResolved(dir) === current);
  const mine =
    rows.find(holds) ?? readAccountGroup({ members: [{ label: accountLabel(current), configDir: current }] }, options);
  const lines = rows.filter((row) => !holds(row)).map(otherLine).filter((line) => line !== null);
  return [currentLine(figuresOf(mine)), ...lines];
}
