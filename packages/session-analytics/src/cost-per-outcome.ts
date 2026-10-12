import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { readSessionCosts, readSessionsByName, readSessionsByTask } from "./cost-per-outcome-queries.js";
import type { ReportWindow } from "./cost-report-queries.js";
import { LIST_PRICE_CAVEAT, table, usd } from "./render-text.js";

/** One dispatch of an agent to a task by a seat, in no product's log format; adapters build these. */
export const assignmentSchema = z.object({
  seat: z.string(),
  agent: z.string(),
  task: z.string().nullable(),
  kind: z.string().nullable(),
  initiative: z.string().nullable(),
  outcome: z.string().nullable(),
  value: z.string().nullable(),
  pr: z.string().nullable(),
  ts: z.string().nullable(),
});

export type Assignment = z.infer<typeof assignmentSchema>;

/** The outcome words `costPerOutcome` counts when the caller names none; adapters normalise into these. */
export const DEFAULT_MERGED_OUTCOMES: readonly string[] = ["merged"];
export const DEFAULT_DONE_OUTCOMES: readonly string[] = ["done"];

export interface CostPerOutcomeOptions extends ReportWindow {
  /** Outcomes that count as merged; defaults to `["merged"]`. */
  mergedOutcomes?: readonly string[];
  /** Outcomes that count as done; defaults to `["done"]`. */
  doneOutcomes?: readonly string[];
}

const count = z.number().int().nonnegative();

const outcomeBucketSchema = z.object({
  key: z.string(),
  assignments: count,
  merged: count,
  done: count,
  costUsd: z.number(),
  /** Bucket cost over merged assignments, parked and failed ones' cost included; null at zero merges. */
  usdPerMerged: z.number().nullable(),
  usdPerDone: z.number().nullable(),
});

export const costPerOutcomeSchema = z.object({
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }),
  totals: outcomeBucketSchema,
  bySeat: z.array(outcomeBucketSchema),
  byKind: z.array(outcomeBucketSchema),
  byInitiative: z.array(outcomeBucketSchema),
  byValue: z.array(outcomeBucketSchema),
  /** The seats' own sessions, kept out of every bucket's `costUsd`. */
  seatCostUsd: z.array(z.object({ key: z.string(), costUsd: z.number() })),
  /** Assignments by how their agent's sessions were found; `seat` is an agent named like a seat. */
  joinSource: z.object({ agentName: count, taskId: count, seat: count, none: count }),
  unmatchedAgents: z.array(z.string()),
});

export type CostPerOutcomeReport = z.infer<typeof costPerOutcomeSchema>;
export type OutcomeBucket = z.infer<typeof outcomeBucketSchema>;
type JoinSource = keyof CostPerOutcomeReport["joinSource"];

const NONE = "(none)";

interface AgentJoin {
  source: JoinSource;
  sessions: string[];
}

/**
 * What each merged and done outcome cost, per seat, kind, initiative and value tag. An agent's
 * window spend is split evenly over its assignments, so a fix round does not cost it twice.
 */
export function costPerOutcome(db: Db, assignments: readonly Assignment[], options: CostPerOutcomeOptions): CostPerOutcomeReport {
  const rows = z.array(assignmentSchema).parse(assignments);
  const window = { since: options.since, until: options.until };
  const costs = readSessionCosts(db, window);
  const seats = [...new Set(rows.map((row) => row.seat))];
  const byName = readSessionsByName(db);
  const joins = joinAgents(db, rows, seats, byName);
  const shares = shareOf(rows, joins, costs);
  const merged = new Set(options.mergedOutcomes ?? DEFAULT_MERGED_OUTCOMES);
  const done = new Set(options.doneOutcomes ?? DEFAULT_DONE_OUTCOMES);
  const group = (keyOf: (row: Assignment) => string | null) => buckets(rows, shares, keyOf, merged, done);
  return {
    window,
    totals: group(() => "total")[0] ?? emptyBucket("total"),
    bySeat: group((row) => row.seat),
    byKind: group((row) => row.kind),
    byInitiative: group((row) => row.initiative),
    byValue: group((row) => row.value),
    seatCostUsd: seatCosts(seats, byName, costs),
    joinSource: joinSourceCounts(rows, joins),
    unmatchedAgents: [...joins].filter(([, join]) => join.source === "none").map(([agent]) => agent).sort(),
  };
}

/** Name match first, then `task_ids`; a session already claimed by a seat or a named agent is never re-costed. */
function joinAgents(db: Db, rows: readonly Assignment[], seats: readonly string[], byName: Map<string, string[]>): Map<string, AgentJoin> {
  const byTask = readSessionsByTask(db, [...new Set(rows.flatMap((row) => (row.task ? [row.task] : [])))]);
  const agents = [...new Set(rows.map((row) => row.agent))].sort();
  const claimed = new Set([...seats, ...agents].flatMap((name) => byName.get(name) ?? []));
  const joins = new Map<string, AgentJoin>();
  for (const agent of agents) {
    if (seats.includes(agent)) joins.set(agent, { source: "seat", sessions: [] });
    else if (byName.has(agent)) joins.set(agent, { source: "agentName", sessions: byName.get(agent)! });
    else joins.set(agent, joinByTask(rows, agent, byTask, claimed));
  }
  return joins;
}

function joinByTask(rows: readonly Assignment[], agent: string, byTask: Map<string, string[]>, claimed: Set<string>): AgentJoin {
  const tasks = rows.filter((row) => row.agent === agent && row.task).map((row) => row.task!);
  const sessions = [...new Set(tasks.flatMap((task) => byTask.get(task) ?? []))].filter((id) => !claimed.has(id));
  for (const id of sessions) claimed.add(id);
  return sessions.length > 0 ? { source: "taskId", sessions } : { source: "none", sessions: [] };
}

function shareOf(rows: readonly Assignment[], joins: Map<string, AgentJoin>, costs: Map<string, number>): Map<string, number> {
  const shares = new Map<string, number>();
  for (const [agent, join] of joins) {
    const spend = sumCosts(new Set(join.sessions), costs);
    shares.set(agent, spend / rows.filter((row) => row.agent === agent).length);
  }
  return shares;
}

function sumCosts(sessions: Iterable<string>, costs: Map<string, number>): number {
  let total = 0;
  for (const id of sessions) total += costs.get(id) ?? 0;
  return total;
}

function buckets(
  rows: readonly Assignment[],
  shares: Map<string, number>,
  keyOf: (row: Assignment) => string | null,
  merged: Set<string>,
  done: Set<string>,
): OutcomeBucket[] {
  const groups = new Map<string, OutcomeBucket>();
  for (const row of rows) {
    const key = keyOf(row) ?? NONE;
    const bucket = groups.get(key) ?? emptyBucket(key);
    bucket.assignments += 1;
    if (row.outcome !== null && merged.has(row.outcome)) bucket.merged += 1;
    if (row.outcome !== null && done.has(row.outcome)) bucket.done += 1;
    bucket.costUsd += shares.get(row.agent) ?? 0;
    groups.set(key, bucket);
  }
  return byCost([...groups.values()].map(withRates));
}

function emptyBucket(key: string): OutcomeBucket {
  return { key, assignments: 0, merged: 0, done: 0, costUsd: 0, usdPerMerged: null, usdPerDone: null };
}

function withRates(bucket: OutcomeBucket): OutcomeBucket {
  const per = (n: number) => (n > 0 ? bucket.costUsd / n : null);
  return { ...bucket, usdPerMerged: per(bucket.merged), usdPerDone: per(bucket.done) };
}

function byCost<T extends { key: string; costUsd: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
}

function seatCosts(seats: readonly string[], byName: Map<string, string[]>, costs: Map<string, number>): CostPerOutcomeReport["seatCostUsd"] {
  return byCost(seats.map((seat) => ({ key: seat, costUsd: sumCosts(new Set(byName.get(seat) ?? []), costs) })));
}

function joinSourceCounts(rows: readonly Assignment[], joins: Map<string, AgentJoin>): CostPerOutcomeReport["joinSource"] {
  const counts = { agentName: 0, taskId: 0, seat: 0, none: 0 };
  for (const row of rows) counts[joins.get(row.agent)!.source] += 1;
  return counts;
}

/** The report as plain-text tables: totals, the four groupings, seat spend, the join line and the caveat. */
export function renderCostPerOutcomeText(report: CostPerOutcomeReport): string {
  const { since, until } = report.window;
  const { agentName, taskId, seat, none } = report.joinSource;
  const unmatched = report.unmatchedAgents.length > 0 ? report.unmatchedAgents.join(", ") : "none";
  return [
    `Cost per outcome, ${since ?? "start"} to ${until ?? "now"}`,
    bucketTable("Totals", [report.totals]),
    bucketTable("By seat", report.bySeat),
    bucketTable("By kind", report.byKind),
    bucketTable("By initiative", report.byInitiative),
    bucketTable("By value", report.byValue),
    table("Seat spend (not in any bucket)", ["seat", "cost"], report.seatCostUsd.map((row) => [row.key, usd(row.costUsd)])),
    `Joined by: agent name ${agentName}, task id ${taskId}, seat ${seat}, none ${none}.`,
    `Unmatched agents: ${unmatched}`,
    LIST_PRICE_CAVEAT,
  ].join("\n\n");
}

function bucketTable(title: string, rows: readonly OutcomeBucket[]): string {
  const rate = (value: number | null) => (value === null ? "-" : usd(value));
  const head = ["key", "assignments", "merged", "done", "cost", "per merged", "per done"];
  return table(title, head, rows.map((row) => [row.key, row.assignments, row.merged, row.done, usd(row.costUsd), rate(row.usdPerMerged), rate(row.usdPerDone)]));
}
