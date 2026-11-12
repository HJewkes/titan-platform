import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { isoWeek, readPhaseWeeks, readTaskRows, readWeekRows, type TaskRow, type WeekRow } from "@titan-design/session-analytics";
import { expandHome } from "@titan-design/session-read";
import type { Db } from "@titan-design/store-sqlite";
import { openReadOnly } from "./broker.js";
import { readCommand } from "./owner-guard.js";
import { taskResult, tasksResult, weeksResult, type ScorecardStoreState, type ScorecardTaskRow, type ScorecardWeek } from "./scorecard-schema.js";

/** The ticket scorecard's store, which `session-miner ticket-scorecard run` writes; its frozen weeks sit in `weeks/` beside it. */
export interface ScorecardSource {
  storeFile: string;
}

export interface ScorecardConfig {
  /** The ticket scorecard store, read-only; absent in a hand-built config, the `scorecard.*` reads are not served. */
  scorecardStore?: string;
}

/** The store the job writes: `TITAN_SCORECARD_STORE`, else `$XDG_DATA_HOME/titan-scorecard/scorecard.sqlite3`, as session-miner resolves it. */
export function scorecardStoreFrom(env: NodeJS.ProcessEnv, home: string = os.homedir()): string {
  const dataHome = env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  return expandHome(env.TITAN_SCORECARD_STORE ?? path.join(dataHome, "titan-scorecard", "scorecard.sqlite3"), home);
}

const TASKS_SHOWN = 25;

type Read<T> = { store: ScorecardStoreState; value: T | null };

/** Opens the store read-only for one read; the console never writes it, so a running job is never disturbed. */
function withStore<T>(file: string, read: (db: Db) => T): Read<T> {
  if (!existsSync(file)) return { store: { state: "missing", detail: "no scorecard store on this host yet; the ticket-scorecard job writes it" }, value: null };
  const db = openReadOnly(file);
  if (db === null) return { store: { state: "unreadable", detail: "the scorecard store would not open read-only" }, value: null };
  try {
    return { store: { state: "ok" }, value: read(db) };
  } catch (error) {
    return { store: { state: "unreadable", detail: error instanceof Error ? error.message.split("\n")[0]! : String(error) }, value: null };
  } finally {
    db.close();
  }
}

/** Which weeks the job froze, and which of those later drifted, from the file names alone. */
function frozenFiles(weeksDir: string): { frozen: Set<string>; drift: Set<string> } {
  const names = existsSync(weeksDir) ? readdirSync(weeksDir) : [];
  const stems = (suffix: string) => new Set(names.filter((name) => name.endsWith(suffix)).map((name) => name.slice(0, -suffix.length)));
  const drift = stems(".drift.json");
  return { frozen: new Set([...stems(".json")].filter((stem) => !stem.endsWith(".drift"))), drift };
}

function groupWeeks(cells: readonly WeekRow[], phases: ReturnType<typeof readPhaseWeeks>, weeksDir: string): ScorecardWeek[] {
  const files = frozenFiles(weeksDir);
  const weeks = [...new Set([...cells.map((c) => c.isoWeek), ...phases.map((p) => p.isoWeek)])].sort().reverse();
  return weeks.map((week) => ({
    isoWeek: week,
    frozen: files.frozen.has(week),
    drift: files.drift.has(week),
    cells: cells.filter((c) => c.isoWeek === week).map(({ dimension, key, metrics, redFlags }) => ({ dimension, key, metrics, redFlags })),
    phases: phases.filter((p) => p.isoWeek === week),
  }));
}

export function readScorecardWeeks({ storeFile }: ScorecardSource): z.infer<typeof weeksResult> {
  const read = withStore(storeFile, (db) => ({ cells: readWeekRows(db), phases: readPhaseWeeks(db) }));
  const weeks = read.value === null ? [] : groupWeeks(read.value.cells, read.value.phases, path.join(path.dirname(storeFile), "weeks"));
  return { store: read.store, weeks };
}

const shown = ({ inputsHash: _hash, ...row }: TaskRow): ScorecardTaskRow => row;

const newestFirst = (a: TaskRow, b: TaskRow): number => (a.firstDispatchTs < b.firstDispatchTs ? 1 : a.firstDispatchTs > b.firstDispatchTs ? -1 : 0);

/** A task still to review: it rests on an inferred label and has neither merged nor been closed with a reason. */
const openAndInferred = (row: TaskRow): boolean => row.mergedAt === null && row.doneReason === null && Object.values(row.provenance).some((origin) => origin !== "recorded");

interface TasksQuery {
  week?: string | undefined;
  inferred?: boolean | undefined;
}

export function readScorecardTasks({ storeFile }: ScorecardSource, { week, inferred }: TasksQuery): z.infer<typeof tasksResult> {
  const read = withStore(storeFile, readTaskRows);
  const matched = (read.value ?? []).filter((row) => (week === undefined || isoWeek(row.firstDispatchTs) === week) && (inferred !== true || openAndInferred(row)));
  return { store: read.store, total: matched.length, rows: matched.sort(newestFirst).slice(0, TASKS_SHOWN).map(shown) };
}

export function readScorecardTask({ storeFile }: ScorecardSource, initiative: string, taskId: string): z.infer<typeof taskResult> {
  const read = withStore(storeFile, readTaskRows);
  const row = (read.value ?? []).find((r) => r.initiative === initiative && r.taskId === taskId);
  return { store: read.store, row: row === undefined ? null : shown(row) };
}

const ISO_WEEK = /^\d{4}-W\d{2}$/;

/** Reads only: the page shows what the job stored and computes no figure of its own. */
export function scorecardCommands(source: ScorecardSource) {
  return {
    "scorecard.weeks": readCommand({
      name: "scorecard.weeks",
      description: "The ticket scorecard's weekly cells (all, per initiative, per dispatcher), red flags, Shepherd phase medians, and which weeks are frozen or drifted",
      args: z.object({}),
      result: weeksResult,
      run: async () => readScorecardWeeks(source),
    }),
    "scorecard.tasks": readCommand({
      name: "scorecard.tasks",
      description: "Scorecard task rows, newest dispatch first and capped: one ISO week's, or the open ones resting on an inferred label",
      args: z.object({ week: z.string().regex(ISO_WEEK).optional(), inferred: z.boolean().optional() }),
      result: tasksResult,
      run: async (query) => readScorecardTasks(source, query),
    }),
    "scorecard.task": readCommand({
      name: "scorecard.task",
      description: "One scorecard task row with the provenance of each labelled column",
      args: z.object({ initiative: z.string().min(1), taskId: z.string().min(1) }),
      result: taskResult,
      run: async ({ initiative, taskId }) => readScorecardTask(source, initiative, taskId),
    }),
  };
}
