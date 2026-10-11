import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";

/** One line of a seat's `dispatch.jsonl`, with the seat taken from its directory and `at` in epoch ms. */
export interface DispatchRecord {
  seat: string;
  at: number;
  ts: string;
  task?: string;
  pr?: string;
  outcome?: string;
  milestone?: string;
  note?: string;
  usd_est?: unknown;
}

export type ScorecardJournalRowId = "rework" | "mechanical" | "autonomy" | "cost";

/** A scorecard row; `value` is null, never zero, when its source is absent or empty. */
export interface ScorecardRow {
  id: string;
  metric: string;
  value: string | null;
  source: string;
  measured: boolean;
  /** Set on the cost row only: merged tasks with a retired usd_est, out of all merged tasks in the window. */
  coverage?: { tasksWithUsdEst: number; mergedTasks: number };
}

export interface ScorecardJournalInput {
  /** agent-chat's events.db, opened read-only by the caller; null when the file is absent. */
  eventsDb: Db | null;
  /** Every journal record, any window: the cost row sums spend from before the window. */
  dispatchRecords: readonly DispatchRecord[];
  since: string;
  now: string;
}

export const NOT_MEASURED = "not measured";

/** Below this share of merged tasks carrying a retired usd_est, the cost row stays unmeasured so a sparse sample never prints. */
export const MIN_COST_COVERAGE = 0.8;

/** Parses an ISO time that may carry a `-0600` offset or none; no offset reads as UTC, as the journals write it. */
function parseTs(text: string): number {
  const iso = text.replace(/Z$/, "+00:00").replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  return Date.parse(/[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
}

const optionalText = z.string().optional().catch(undefined);

/** A field of the wrong type reads as absent rather than dropping the line, as the Python script tolerates it. */
const journalLineSchema = z.object({
  ts: z.string(),
  task: optionalText,
  pr: optionalText,
  outcome: optionalText,
  milestone: optionalText,
  note: optionalText,
  usd_est: z.unknown().optional(),
});

function parseJournalLine(line: string, seat: string): DispatchRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const record = journalLineSchema.safeParse(value);
  if (!record.success) return null;
  const at = parseTs(record.data.ts);
  return Number.isNaN(at) ? null : { ...record.data, seat, at };
}

/** Every record of each `<dir>/<seat>/dispatch.jsonl`; an absent dir or journal reads as none, and an unparseable line is skipped. */
export function readDispatchJournal(dir: string): DispatchRecord[] {
  if (!existsSync(dir)) return [];
  const seats = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  return seats.flatMap(({ name: seat }) => {
    const file = path.join(dir, seat, "dispatch.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => parseJournalLine(line, seat) ?? []);
  });
}

function pct(part: number, whole: number): string {
  return `${((100 * part) / whole).toFixed(1)} percent (${part} of ${whole})`;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function lineValue(body: string, label: string): string | null {
  return new RegExp(`^${label}:\\s*(\\S+)`, "m").exec(body)?.[1] ?? null;
}

const verdictRowsSchema = z.array(z.object({ actor: z.string(), body: z.string(), ts: z.number() }));

type VerdictRow = z.infer<typeof verdictRowsSchema>[number];

/** Verdict messages in [since, now]; a missing events table reads as none, like an absent file. */
function verdictRows(db: Db | null, prefix: string, since: number, now: number): VerdictRow[] {
  if (!db) return [];
  try {
    const rows = verdictRowsSchema.parse(db.prepare("SELECT actor, body, ts FROM events WHERE kind = 'message' AND body LIKE ? ORDER BY id").all(`${prefix}%`));
    return rows.filter((row) => row.ts >= since && row.ts <= now);
  } catch {
    return [];
  }
}

function firstPassFixFirst(rows: readonly VerdictRow[]): string | null {
  const first = new Map<string, string>();
  for (const { body } of rows) {
    const verdict = /^Verdict:\s*(\w+)/.exec(body)?.[1];
    const pr = lineValue(body, "PR")?.toLowerCase();
    // WAIT means CI had not finished; the next verdict at that PR decides the first pass
    if (verdict && pr && verdict !== "WAIT" && !first.has(pr)) first.set(pr, verdict);
  }
  const fix = [...first.values()].filter((v) => v === "FIX_FIRST").length;
  return first.size ? pct(fix, first.size) : null;
}

/** Share of FIX_FIRST rounds, deduped by reviewer, PR and head, whose Class line names a mechanical first blocker (not defect or test). */
function mechanicalFirstBlocker(rows: readonly VerdictRow[]): string | null {
  const rounds = new Map<string, string | null>();
  for (const { actor, body } of rows) {
    const key = JSON.stringify([actor, lineValue(body, "PR"), lineValue(body, "Head")]);
    if (!rounds.has(key)) rounds.set(key, lineValue(body, "Class"));
  }
  if (!rounds.size) return null;
  const classes = [...rounds.values()].filter((c): c is string => !!c);
  const unclassified = `${rounds.size - classes.length} unclassified of ${rounds.size} FIX_FIRST rounds`;
  if (!classes.length) return `n/a (no Class line yet; ${unclassified})`;
  const mechanical = classes.filter((c) => !c.startsWith("defect") && !c.startsWith("test")).length;
  return `${pct(mechanical, classes.length)} of classified; ${unclassified}`;
}

function milestoneSpawns(records: readonly DispatchRecord[]): string | null {
  const tagged = records.filter((d) => d.outcome === "dispatched" && (d.milestone || /milestone:\S+/.test(d.note ?? "")));
  if (!tagged.length) return null;
  const coord = tagged.filter((d) => d.seat.endsWith("-coord")).length;
  return `${pct(coord, tagged.length)} dispatched by a coordinator seat`;
}

/** Per task merged in the window, the usd_est of every retired row for that task in any seat's journal and any earlier window. */
function costPerMerge(inWindow: readonly DispatchRecord[], history: readonly DispatchRecord[]): Pick<ScorecardRow, "value" | "coverage"> {
  const tasks = new Set(inWindow.flatMap((d) => (d.outcome?.startsWith("merged") && d.task ? [d.task] : [])));
  const spend = new Map<string, number>();
  for (const d of history) {
    if (d.outcome === "retired" && d.task && tasks.has(d.task) && typeof d.usd_est === "number") spend.set(d.task, (spend.get(d.task) ?? 0) + d.usd_est);
  }
  const coverage = { tasksWithUsdEst: spend.size, mergedTasks: tasks.size };
  if (!tasks.size || spend.size / tasks.size < MIN_COST_COVERAGE) return { value: null, coverage };
  const total = [...spend.values()].reduce((sum, usd) => sum + usd, 0);
  const value = `$${(total / tasks.size).toFixed(2)} per merged task (median $${median([...spend.values()]).toFixed(2)}; $${total.toFixed(2)} over ${tasks.size} merged tasks)`;
  return { value, coverage };
}

function row(id: ScorecardJournalRowId, metric: string, value: string | null, source: string): ScorecardRow {
  return { id, metric, value, source, measured: value !== null };
}

/** The scorecard rows read from events.db verdicts and seat dispatch journals, in scripts/seat/scorecard's order and wording. */
export function scorecardJournalRows(input: ScorecardJournalInput): ScorecardRow[] {
  const since = Date.parse(input.since);
  const now = Date.parse(input.now);
  const history = input.dispatchRecords.filter((d) => d.at <= now);
  const inWindow = history.filter((d) => d.at >= since);
  const cost = costPerMerge(inWindow, history);
  return [
    row("rework", "First-pass FIX_FIRST share", firstPassFixFirst(verdictRows(input.eventsDb, "Verdict:", since, now)), "events.db verdicts"),
    row("mechanical", "Mechanical first-blocker share", mechanicalFirstBlocker(verdictRows(input.eventsDb, "Verdict: FIX_FIRST", since, now)), "events.db FIX_FIRST Class line"),
    row("autonomy", "Coordinator spawns for milestone tasks", milestoneSpawns(inWindow), "dispatch.jsonl"),
    { ...row("cost", "Cost per merged PR", cost.value, "dispatch.jsonl usd_est"), coverage: cost.coverage },
  ];
}

/** A row's value as the scorecard prints it: the cost row names its usd_est coverage whether or not it is measured. */
export function scorecardRowText(r: ScorecardRow): string {
  const coverage = r.coverage && `usd_est on ${r.coverage.tasksWithUsdEst} of ${r.coverage.mergedTasks} merged tasks`;
  if (r.value !== null) return coverage ? `${r.value} [${coverage}]` : r.value;
  return coverage ? `${NOT_MEASURED} (${coverage})` : NOT_MEASURED;
}
