import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { errorCode, isObjectLike } from "@titan-design/rpc-protocol/narrow";
import type { Trigger } from "./served/blocks.js";
import type { ClassRow } from "./served/report.js";
import { buildReport, collectServed } from "./served/report.js";
import type { Window } from "./served/session.js";
import { countUptake } from "./uptake.js";

/**
 * One dated measurement row per ISO week: the served arm's opened ratio per
 * trigger and the share of sessions that reached for a recall tool, over the
 * same Monday-to-Monday window. The series is what makes a trend readable;
 * the other verbs print one-off snapshots.
 */

interface TriggerRow {
  served: number;
  opened: number;
  ratio: number;
}

interface WeeklyRow {
  week: string;
  triggers: Record<Trigger, TriggerRow>;
  recallSessionShare: number;
}

interface WeeklyOptions {
  week: string;
  out: string;
  files: string[];
  activeRoot: string;
}

const WEEK_FORMAT = /^(\d{4})-W(\d{2})$/;
const DAY_MS = 86_400_000;

function malformed(week: string): Error {
  return new Error(`--week must look like YYYY-Www with a week that exists in that ISO year, got ${week}`);
}

/** Monday 00:00 UTC of ISO week 1: the week holding January 4th. */
function weekOneMonday(year: number): number {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  return jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY_MS;
}

/** Half-open `[Monday, next Monday)` in UTC for an ISO week label. */
export function isoWeekWindow(week: string): Required<Window> {
  const match = WEEK_FORMAT.exec(week);
  if (match === null) throw malformed(week);
  const year = Number(match[1]);
  const number = Number(match[2]);
  const since = weekOneMonday(year) + (number - 1) * 7 * DAY_MS;
  const weeksInYear = (weekOneMonday(year + 1) - weekOneMonday(year)) / (7 * DAY_MS);
  if (number < 1 || number > weeksInYear) throw malformed(week);
  return { since: new Date(since).toISOString(), until: new Date(since + 7 * DAY_MS).toISOString() };
}

async function measureWeek(options: Omit<WeeklyOptions, "out">): Promise<WeeklyRow> {
  const window = isoWeekWindow(options.week);
  const served = buildReport(await collectServed(options.files, options.activeRoot, window), window, options.files.length);
  const uptake = await countUptake(options.files, window);
  const triggers = { bootstrap: triggerRow(served.byClass, "bootstrap"), spawn: triggerRow(served.byClass, "spawn") };
  const recallSessionShare =
    uptake.transcriptsWithToolUse === 0 ? 0 : uptake.sessionsUsingRecall / uptake.transcriptsWithToolUse;
  return { week: options.week, triggers, recallSessionShare };
}

function triggerRow(byClass: ClassRow[], trigger: Trigger): TriggerRow {
  const rows = byClass.filter((row) => row.trigger === trigger);
  const served = rows.reduce((sum, row) => sum + row.served, 0);
  const opened = rows.reduce((sum, row) => sum + row.opened, 0);
  return { served, opened, ratio: served === 0 ? 0 : opened / served };
}

function existingLines(file: string): string[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

function weekOf(line: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isObjectLike(parsed) ? String(parsed.week) : undefined;
  } catch {
    return undefined;
  }
}

/** Measures the week and rewrites its line in place, so a re-run never duplicates it. */
export async function writeWeekly(options: WeeklyOptions): Promise<WeeklyRow> {
  const row = await measureWeek(options);
  const kept = existingLines(options.out).filter((line) => weekOf(line) !== row.week);
  mkdirSync(path.dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${[...kept, JSON.stringify(row)].join("\n")}\n`);
  return row;
}
