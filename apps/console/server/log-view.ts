/**
 * `log.list` (TP-6775): the #/log "Decisions and ships" page. It merges three sources, newest first and grouped by day:
 * every PR Shepherd merged in the window, Shepherd's auto-by-rec rows for approve-merge gates, and the console's own
 * auto-by-rec rows for rounds and deposits. The header carries the by-rec policy: mode, wait and the exclusion list.
 * Read only: no source here is written, and an unreadable source is a gap line beside the rest.
 */
import { z } from "zod";
import type { ByRecRow } from "@titan-design/owner-queue";
import { readByRecPolicy, readByRecRows } from "./by-rec-log.js";
import { DEFAULT_DAY_START, dayWindow, type DayWindow } from "./coord-day.js";
import { approvalOf, type ApprovalRead } from "./log-approval.js";
import { logHeader, type LogHeader } from "./log-floor.js";
import type { GateRowsSource } from "./log-gate-rows.js";
import { digestLine, logCounts, mergeLog, type LogCounts, type LogRow, type ShipInput } from "./log-rows.js";
import { readCommand } from "./owner-guard.js";
import type { ShepherdSource } from "./shepherd.js";
import { mergeTimes, mergedRunsInWindow, type FinishedRow } from "./shipped.js";

export interface LogSource {
  /** The console state dir, which holds the by-rec policy file and the console's own rows. */
  stateDir: string;
  gateRows: GateRowsSource;
  dayStart?: string;
  now?: () => number;
}

export interface LogView {
  header: LogHeader;
  days: { date: string; rows: LogRow[] }[];
  counts: LogCounts;
  digest: string;
  gaps: string[];
  readAt: string;
}

const DEFAULT_LOG_DAYS = 7;
const MAX_LOG_DAYS = 30;
const DAY_MS = 86_400_000;

type Shepherd = Pick<ShepherdSource, "list" | "timeline">;

/** A finished run's approval never changes, so each source reads a run's timeline for it at most once. */
const approvalCache = new WeakMap<object, Map<string, ApprovalRead>>();

async function approvalFor(shepherd: Shepherd, row: FinishedRow): Promise<ApprovalRead> {
  const known = approvalCache.get(shepherd) ?? new Map<string, ApprovalRead>();
  approvalCache.set(shepherd, known);
  const cached = known.get(row.runId);
  if (cached !== undefined) return cached;
  const read = await shepherd.timeline(row.repo, row.pr!).then(
    ({ entries }) => approvalOf(entries),
    () => undefined,
  );
  if (read === undefined) return { approval: "unrecorded" };
  known.set(row.runId, read);
  return read;
}

async function readShips(shepherd: Shepherd, window: DayWindow): Promise<{ ships: ShipInput[]; gaps: string[] }> {
  let finished: FinishedRow[];
  try {
    finished = await shepherd.list("finished");
  } catch (error) {
    return { ships: [], gaps: [`shepherd: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const times = await mergeTimes(shepherd, finished, window);
  const merged = mergedRunsInWindow(finished, window, times);
  const ships = await Promise.all(
    merged.map(async ({ row, ref }) => {
      const { approval, rule } = await approvalFor(shepherd, row);
      const mergedAt = times.get(row.runId) ?? Date.parse(row.phaseSince);
      return { repo: ref.repo, pr: ref.number, task: ref.task, url: ref.url, mergedAt, approval, ...(rule !== undefined && { rule }) };
    }),
  );
  return { ships, gaps: [] };
}

async function readConsoleRows(stateDir: string): Promise<{ rows: ByRecRow[]; gaps: string[] }> {
  try {
    return { rows: await readByRecRows(stateDir), gaps: [] };
  } catch (error) {
    return { rows: [], gaps: [`console by-rec log: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

function windowOf(now: number, dayStart: string, days: number): DayWindow {
  const today = dayWindow(now, dayStart);
  return { ...today, from: today.from - (days - 1) * DAY_MS };
}

const inWindow = (window: DayWindow) => (row: ByRecRow) => Date.parse(row.resolvedAt) >= window.from && Date.parse(row.resolvedAt) < window.to;

function byDay(rows: readonly LogRow[]): LogView["days"] {
  const days = new Map<string, LogRow[]>();
  for (const row of rows) days.set(row.day, [...(days.get(row.day) ?? []), row]);
  return [...days].map(([date, dayRows]) => ({ date, rows: dayRows }));
}

export async function readLog(shepherd: Shepherd, source: LogSource, days: number = DEFAULT_LOG_DAYS): Promise<LogView> {
  const now = (source.now ?? Date.now)();
  const dayStart = source.dayStart ?? DEFAULT_DAY_START;
  const window = windowOf(now, dayStart, days);
  const [policy, ships, gates, asked] = await Promise.all([readByRecPolicy(source.stateDir), readShips(shepherd, window), source.gateRows(days), readConsoleRows(source.stateDir)]);
  const rows = mergeLog({ ships: ships.ships, gateRows: gates.rows.filter(inWindow(window)), consoleRows: asked.rows.filter(inWindow(window)), dayOf: (ms) => dayWindow(ms, dayStart).date });
  const counts = logCounts(rows);
  return {
    header: logHeader(policy.policy, policy.problem),
    days: byDay(rows),
    counts,
    digest: digestLine(counts),
    gaps: [...ships.gaps, ...gates.gaps, ...asked.gaps],
    readAt: new Date(now).toISOString(),
  };
}

export function logCommands(shepherd: ShepherdSource, source: LogSource) {
  return {
    "log.list": readCommand({
      name: "log.list",
      description:
        "The Decisions and ships log: every PR Shepherd merged and every auto-by-rec decision (Shepherd's approve-merge gates, the console's rounds and deposits), newest first by day, one row per PR, each with how it was approved, the recommendation, rationale, times and its reverse link; with the by-rec mode, wait and exclusion floor, and the digest line's counts",
      args: z.object({ days: z.number().int().min(1).max(MAX_LOG_DAYS).optional().describe(`days back, today included; ${DEFAULT_LOG_DAYS} when left out`) }),
      result: z.custom<LogView>(),
      run: ({ days }) => readLog(shepherd, source, days),
    }),
  };
}
