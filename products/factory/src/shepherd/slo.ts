import { readFileSync } from "node:fs";
import { METRICS_SCHEMA_ID, validateEntry, type MetricsEntryRead } from "@titan-design/health/metrics";
import { parse } from "yaml";
import { SLO_QUERIES, type QueryValue, type SloInput } from "./slo-queries.js";
import type { StatsRange } from "./stats.js";

/** The store id a registry query names when `shepherd stats --slo` runs it; its `text` is a key of `SLO_QUERIES`. */
export const SLO_STORE = "shepherd-stats";

export type SloBase = Omit<SloInput, "range">;
type Metric = MetricsEntryRead["metrics"][number];

const STATUSES = ["pass", "fail", "no-data", "no-slo", "no-query", "error"] as const;
type SloStatus = (typeof STATUSES)[number];

export interface SloResult {
  id: string;
  family: string;
  title: string;
  unit: string;
  query: string | null;
  from: string | null;
  to: string | null;
  value: number | null;
  n: number;
  slo: { objective: string; op: string; target: number } | null;
  status: SloStatus;
  /** The gap slice of a metric with no query, or why a query could not run. */
  detail?: string;
}

const DAY_MS = 86_400_000;
const WINDOW_DAYS = { "1d": 1, "7d": 7, "28d": 28 } as const;
const day = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The SLO's window as whole UTC days ending today; a metric with no SLO reads the last seven. */
function windowOf(metric: Metric, now: number, override: StatsRange): { from: string; to: string } {
  const days = WINDOW_DAYS[metric.slo?.window ?? "7d"];
  return { from: override.from ?? day(now - (days - 1) * DAY_MS), to: override.to ?? day(now) };
}

/** Reads and validates a `titan.metrics/v1` entry; throws naming every failing field. */
export function readRegistry(path: string): MetricsEntryRead {
  const result = validateEntry(parse(readFileSync(path, "utf8")), "read");
  if (!result.ok) throw new Error(`${path}: ${result.errors.join("; ")}`);
  if (result.entry.schema !== METRICS_SCHEMA_ID) throw new Error(`${path}: schema: expected ${METRICS_SCHEMA_ID}`);
  return result.entry as MetricsEntryRead;
}

function judge(metric: Metric, value: number | null): SloStatus {
  if (value === null) return "no-data";
  if (!metric.slo) return "no-slo";
  if (metric.slo.op === "between") throw new Error("op between needs two bounds; the registry holds one target");
  return (metric.slo.op === "<=" ? value <= metric.slo.target : value >= metric.slo.target) ? "pass" : "fail";
}

function queryOf(metric: Metric): string {
  const query = metric.query!;
  if (query.kind !== "cli" || query.store !== SLO_STORE) throw new Error(`not a ${SLO_STORE} query: ${query.kind} on ${query.store}`);
  if (!Object.hasOwn(SLO_QUERIES, query.text)) throw new Error(`unknown query ${query.text}`);
  return query.text;
}

async function evaluate(metric: Metric, base: SloBase, override: StatsRange): Promise<SloResult> {
  const slo = metric.slo ? { objective: metric.slo.objective, op: metric.slo.op, target: metric.slo.target } : null;
  const head = { id: metric.id, family: metric.family, title: metric.title, unit: metric.unit, query: metric.query?.text ?? null };
  if (!metric.query) return { ...head, from: null, to: null, value: null, n: 0, slo, status: "no-query", detail: `gap ${metric.source.gapSlice ?? "unnamed"}` };
  const range = windowOf(metric, base.now, override);
  let measured: QueryValue = { value: null, n: 0 };
  try {
    measured = await SLO_QUERIES[queryOf(metric)]!({ ...base, range });
    return { ...head, ...range, ...measured, slo, status: judge(metric, measured.value) };
  } catch (error) {
    return { ...head, ...range, value: null, n: measured.n, slo, status: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Every registry metric in file order: its value over its SLO window (or `override`), and whether it meets the SLO. */
export async function evaluateSlo(entry: MetricsEntryRead, base: SloBase, override: StatsRange = {}): Promise<SloResult[]> {
  const results: SloResult[] = [];
  for (const metric of entry.metrics) results.push(await evaluate(metric, base, override));
  return results;
}

function line(result: SloResult): string {
  const lead = `${result.status.padEnd(8)}  ${result.id}`;
  if (result.status === "no-query" || result.status === "error") return `${lead}  ${result.detail}`;
  const slo = result.slo ? `SLO ${result.slo.op} ${result.slo.target} (${result.slo.objective})` : "no SLO";
  return `${lead}  ${result.value ?? "-"} ${result.unit}  ${slo}  ${result.from}..${result.to}  n ${result.n}`;
}

export function formatSlo(results: readonly SloResult[]): string {
  const tally = STATUSES.map((status) => `${status} ${results.filter((result) => result.status === status).length}`).join("  ");
  return `${[...results.map(line), "", tally].join("\n")}\n`;
}
