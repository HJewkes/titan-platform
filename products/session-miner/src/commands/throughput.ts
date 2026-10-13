import { defineCommand } from "@titan-design/registry";
import { taskActuals, type TaskActualsOptions } from "@titan-design/session-analytics";
import { openSessionGraph, type SessionGraph } from "@titan-design/session-graph";
import { backtest, classTable, type BacktestResult, type ClassTable, type Coverage, type ThroughputRow, type Watermark } from "@titan-design/throughput";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { isoTime } from "../insights/define.js";
import { lastIndexedAt } from "./status.js";
import { loadDoneTasks, toThroughputRows, type UnparsedTask } from "./throughput-rows.js";

const MS_PER_DAY = 86_400_000;
export const DEFAULT_WEEKS = 4;
export const DEFAULT_HORIZON_DAYS = 7;

/** What every throughput result says about its inputs, so a reader can tell which model and data produced it. */
export interface ThroughputInputs {
  modelHash: string;
  watermark: Watermark;
  initiatives: string[];
  /** Done tasks read from the allowlist, one row each. */
  rows: number;
  /** Rows with no implementer session, left out of the fit. */
  excludedRows: number;
  /** Tasks with more than one `kind:` tag; each was classed by its first. */
  multiKind: number;
  unparsed: UnparsedTask[];
  missingInitiatives: string[];
}

interface ThroughputTableResult extends ThroughputInputs {
  table: ClassTable;
}

interface ThroughputBacktestResult extends ThroughputInputs {
  backtest: BacktestResult;
}

export const FitArgs = {
  cap: z.number().positive().optional().describe("idle cap in minutes behind the headline agent-hours (default 15)"),
  asOf: isoTime.optional().describe("time recency weights count back from (default: newest done task)"),
  halfLife: z.number().positive().optional().describe("recency half-life in days (default 21)"),
  minN: z.number().int().nonnegative().optional().describe("weighted rows a class needs before it stops backing off (default 20)"),
};

export const FIT_OPTIONS = {
  cap: { long: "--cap", description: "idle cap in minutes (default 15)" },
  asOf: { long: "--as-of", description: "ISO time recency weights count back from" },
  halfLife: { long: "--half-life", description: "recency half-life in days (default 21)" },
  minN: { long: "--min-n", description: "weighted rows before a class stops backing off (default 20)" },
};

const TableArgs = z.object(FitArgs).strict();
type TableArgs = z.infer<typeof TableArgs>;

const BacktestArgs = z
  .object({
    ...FitArgs,
    origin: z.array(isoTime).optional().describe("origin date to refit at (repeatable); overrides --weeks"),
    weeks: z.number().int().positive().optional().describe("weekly origins ending one horizon before the newest done task (default 4)"),
    horizon: z.number().positive().optional().describe("days after each origin to score (default 7)"),
    metric: z.enum(["implAgentHours", "reviewAgentHours", "usd"]).optional().describe("what to score (default implAgentHours)"),
  })
  .strict();
type BacktestArgs = z.infer<typeof BacktestArgs>;

export interface LoadedRows {
  rows: ThroughputRow[];
  minerIndexedAt: string | null;
  inputs: Omit<ThroughputInputs, "modelHash" | "watermark" | "excludedRows">;
}

/** Optional joins a caller adds to every row; the table and backtest pass none. */
export type RowJoins = Pick<TaskActualsOptions, "prDiffs" | "shepherdRuns">;

/** Reads the graph strictly read-only, even the miner's own index: `ctx.graph()` would migrate and reprice it. */
export function loadRows(ctx: MinerContext, capMinutes: number | undefined, joins: RowJoins = {}): LoadedRows {
  const { initiativesRoot, throughputInitiatives: initiatives, dbPath } = ctx.config;
  const load = loadDoneTasks(initiativesRoot, initiatives);
  for (const initiative of load.missing) ctx.warnings.push(`initiative ${initiative} has no tasks directory under ${initiativesRoot}`);
  const graph = openSessionGraph(dbPath, { readonly: true });
  try {
    if (countTaskLinkedOrigins(graph) === 0) ctx.warnings.push(`${dbPath} has no task-linked sessions; pass --graph with active-work's graph`);
    const actuals = taskActuals(graph.db, load.tasks, { initiatives, capMinutes, ...joins });
    const multiKind = load.tasks.filter((task) => task.multiKind).length;
    return {
      rows: toThroughputRows(actuals, load.tasks),
      minerIndexedAt: lastIndexedAt(graph),
      inputs: { initiatives: [...initiatives], rows: actuals.length, multiKind, unparsed: load.unparsed, missingInitiatives: load.missing },
    };
  } finally {
    graph.db.close();
  }
}

const CountRow = z.object({ n: z.number() });

function countTaskLinkedOrigins(graph: SessionGraph): number {
  return CountRow.parse(graph.db.prepare("SELECT count(*) AS n FROM session_origin WHERE task_ids IS NOT NULL").get()).n;
}

function fitTable(loaded: LoadedRows, args: TableArgs): { table: ClassTable; inputs: ThroughputInputs } {
  const config = { asOf: args.asOf, halfLifeDays: args.halfLife, minN: args.minN, minerIndexedAt: loaded.minerIndexedAt ?? undefined };
  const table = classTable(loaded.rows, config);
  return { table, inputs: { modelHash: table.modelHash, watermark: table.watermark, excludedRows: table.excludedRows, ...loaded.inputs } };
}

export const throughputTable = defineCommand<TableArgs, ThroughputTableResult | string, MinerContext>({
  name: "throughput.table",
  description: "Per-class agent-hours and USD quantiles over done tasks in the initiative allowlist, with the model hash and watermark",
  args: TableArgs,
  result: z.union([z.custom<ThroughputTableResult>(), z.string()]),
  cli: { options: FIT_OPTIONS },
  async run(args, ctx) {
    const { table, inputs } = fitTable(loadRows(ctx, args.cap), args);
    return ctx.format === "human" ? [renderInputs(inputs), ...renderClasses(table)].join("\n") : { ...inputs, table };
  },
});

export const throughputBacktest = defineCommand<BacktestArgs, ThroughputBacktestResult | string, MinerContext>({
  name: "throughput.backtest",
  description: "Rolling-origin back-test of the class table: interval coverage, widened coverage and baselines per origin and class",
  args: BacktestArgs,
  result: z.union([z.custom<ThroughputBacktestResult>(), z.string()]),
  cli: {
    options: {
      ...FIT_OPTIONS,
      origin: { long: "--origin", description: "ISO origin date (repeatable)" },
      weeks: { long: "--weeks", description: "weekly origins to score (default 4)" },
      horizon: { long: "--horizon", description: "days scored after each origin (default 7)" },
      metric: { long: "--metric", description: "implAgentHours, reviewAgentHours or usd" },
    },
  },
  async run(args, ctx) {
    const loaded = loadRows(ctx, args.cap);
    const { table, inputs } = fitTable(loaded, args);
    const horizonDays = args.horizon ?? DEFAULT_HORIZON_DAYS;
    const origins = args.origin ?? weeklyOrigins(table.watermark.newestDoneAt, horizonDays, args.weeks ?? DEFAULT_WEEKS);
    const config = { halfLifeDays: args.halfLife, minN: args.minN, minerIndexedAt: loaded.minerIndexedAt ?? undefined };
    const result = backtest(loaded.rows, { origins, horizonDays, metric: args.metric, config });
    return ctx.format === "human" ? [renderInputs(inputs), ...renderBacktest(result)].join("\n") : { ...inputs, backtest: result };
  },
});

/** `weeks` origins a week apart, the last one a full horizon before the newest done task so its test window is complete. */
export function weeklyOrigins(newestDoneAt: string, horizonDays: number, weeks: number): string[] {
  const last = Date.parse(newestDoneAt) - horizonDays * MS_PER_DAY;
  return Array.from({ length: weeks }, (_, i) => new Date(last - (weeks - 1 - i) * 7 * MS_PER_DAY).toISOString());
}

export function renderInputs(inputs: ThroughputInputs): string {
  const { modelHash, watermark, initiatives, rows, excludedRows, unparsed, multiKind } = inputs;
  const mark = `watermark miner=${watermark.minerIndexedAt ?? "none"} newestDone=${watermark.newestDoneAt}`;
  return `model ${modelHash}  ${mark}  initiatives=${initiatives.join(",")}  rows=${rows} excluded=${excludedRows}  unparsed=${unparsed.length}  multiKind=${multiKind}`;
}

function renderClasses(table: ClassTable): string[] {
  return Object.entries(table.classes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => {
      const q = entry.implAgentHours;
      const impl = `impl h p10 ${hours(q.p10)} p50 ${hours(q.p50)} p80 ${hours(q.p80)} p90 ${hours(q.p90)}`;
      return `${key}  n ${entry.n}  wn ${entry.weightedN.toFixed(1)}  from ${entry.level}:${entry.levelKey}  ${impl}  usd p50 ${entry.usd.p50.toFixed(2)}`;
    });
}

function renderBacktest(result: BacktestResult): string[] {
  const pooled = `pooled ${result.metric} 80% coverage ${coverage(result.pooled.coverage)}  widened ${coverage(result.pooled.widenedCoverage)}`;
  const origins = result.origins.map((o) => {
    const status = o.status === "scored" ? `coverage ${coverage(o.overall.model.coverage)}` : `skipped ${o.reason}`;
    return `origin ${o.origin.slice(0, 10)}  train ${o.trainN}  test ${o.testN}  censored ${o.censored.open}  ${status}`;
  });
  const classes = Object.entries(result.pooled.classes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, c]) => `${key}  coverage ${coverage(c.coverage)}  widened ${coverage(c.widenedCoverage)}`);
  const skipped = `horizon ${result.horizonDays}d  missingFirstImplAt ${result.missingFirstImplAt}`;
  return [pooled, skipped, ...origins, ...classes];
}

export function coverage(c: Coverage): string {
  return c.rate ? `${c.hits}/${c.n} ${(c.rate.estimate * 100).toFixed(0)}% [${(c.rate.lower * 100).toFixed(0)}-${(c.rate.upper * 100).toFixed(0)}]` : `0/0`;
}

function hours(value: number): string {
  return value.toFixed(2);
}
