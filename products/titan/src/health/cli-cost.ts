import type { Command } from "commander";
import { readSamples, storeStats, type HealthSample, type HealthStoreStats } from "@titan-design/health";
import { SELF_TARGET } from "./self-cost.js";
import { windowOf, windowOptions, withReadOnlyStore, type ReportIo, type WindowOptions } from "./cli-uptime.js";

interface PerTick {
  mean: number | null;
  max: number | null;
}

interface CostReport {
  from: string;
  to: string;
  /** One self row per stored tick, so this is the sampler's wakeup count. */
  ticks: number;
  wallMs: PerTick;
  cpuMs: PerTick;
  fsReadBlocks: PerTick;
  fsWriteBlocks: PerTick;
  contextSwitches: PerTick;
  maxRssKb: number | null;
  store: HealthStoreStats;
}

type SelfMetric = (observed: Record<string, unknown>) => number;

function field(observed: Record<string, unknown>, name: string): number {
  const value = observed[name];
  return typeof value === "number" ? value : 0;
}

const METRICS = {
  wallMs: (o) => field(o, "wallMs"),
  cpuMs: (o) => (field(o, "cpuUserUs") + field(o, "cpuSystemUs")) / 1000,
  fsReadBlocks: (o) => field(o, "fsReadBlocks"),
  fsWriteBlocks: (o) => field(o, "fsWriteBlocks"),
  contextSwitches: (o) => field(o, "voluntaryCtx") + field(o, "involuntaryCtx"),
} satisfies Record<string, SelfMetric>;

function perTick(rows: readonly Record<string, unknown>[], metric: SelfMetric): PerTick {
  if (rows.length === 0) return { mean: null, max: null };
  const values = rows.map(metric);
  return { mean: values.reduce((a, b) => a + b, 0) / values.length, max: Math.max(...values) };
}

/** Folds the sampler's self rows; every counter covers the whole oneshot process, node startup included. */
function foldCost(selfRows: readonly HealthSample[], store: HealthStoreStats, from: Date, to: Date): CostReport {
  const rows = selfRows.filter((s) => s.kind === "self").map((s) => s.observed ?? {});
  const metrics = Object.fromEntries(Object.entries(METRICS).map(([name, metric]) => [name, perTick(rows, metric)]));
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    ticks: rows.length,
    ...(metrics as Record<keyof typeof METRICS, PerTick>),
    maxRssKb: perTick(rows, (o) => field(o, "maxRssKb")).max,
    store,
  };
}

function round(value: number | null): string {
  return value === null ? "n/a" : String(Math.round(value * 10) / 10);
}

function renderText(report: CostReport): string {
  const line = (label: string, tick: PerTick) => `${label} per tick: mean ${round(tick.mean)}  max ${round(tick.max)}`;
  return [
    `titan-health-sampler ${report.from} .. ${report.to}: ticks ${report.ticks}`,
    line("wall ms", report.wallMs),
    line("cpu ms", report.cpuMs),
    line("fs read blocks", report.fsReadBlocks),
    line("fs write blocks", report.fsWriteBlocks),
    line("context switches", report.contextSwitches),
    `max rss kb ${round(report.maxRssKb)}`,
    `store ${report.store.rows} rows, ${report.store.bytes} bytes, ${report.store.oldestTs ?? "n/a"} .. ${report.store.newestTs ?? "n/a"}`,
  ].join("\n");
}

function runCost(opts: WindowOptions, dbPath: string, io: ReportIo): number {
  return withReadOnlyStore(dbPath, io, (db) => {
    const { from, to } = windowOf(opts);
    const report = foldCost(readSamples(db, SELF_TARGET, from, to), storeStats(db), from, to);
    io.stdout(`${opts.json ? JSON.stringify(report, null, 2) : renderText(report)}\n`);
    return 0;
  });
}

export function registerCost(health: Command, io: ReportIo, defaultDbPath: () => string): void {
  windowOptions(health.command("cost"), "24h")
    .description("Report the sampler's own cost per tick and the store's size")
    .action((opts: WindowOptions) => io.setExitCode(runCost(opts, opts.db ?? defaultDbPath(), io)));
}
