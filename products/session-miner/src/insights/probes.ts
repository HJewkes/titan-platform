import { readFileSync } from "node:fs";
import { EXIT } from "@titan-design/registry";
import { LIST_PRICE_CAVEAT, type CostReportOptions } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import type { MinerConfig } from "../config.js";
import { defineInsight, localDay, refuseSessionScope } from "./define.js";
import { answerRoundTrips, type RoundTripsReport } from "./round-trips.js";
import { DEFAULT_TOOL_ERRORS_PORTS, answerToolErrors, type ErrorClass, type ToolErrorsPorts, type ToolErrorsReport } from "./tool-errors.js";

/** Daily counts from Q5, by the error class each one counts. */
const ERROR_COUNTS = { sleep_blocks: "sleep-block", graphql_ratelimit_errors: "gh-graphql-ratelimit", wrong_tool_name: "wrong-tool-name" } as const satisfies Record<string, ErrorClass>;
const GRAPH_MEASURES = [...(Object.keys(ERROR_COUNTS) as (keyof typeof ERROR_COUNTS)[]), "classifier_merge_denials"] as const;
const EVENTS_MEASURES = ["verdict_without_pr_line_share", "first_pass_merge_rate"] as const;
export const PROBE_MEASURES = [...GRAPH_MEASURES, ...EVENTS_MEASURES] as const;
export type ProbeMeasure = (typeof PROBE_MEASURES)[number];

const MERGE_DENIAL_REASON = "Merge Without Review";
/** A first-pass share over fewer PRs than this swings on a single verdict, so such a day has no data. */
const MIN_FIRST_VERDICTS = 5;

const probeSchema = z.object({
  id: z.string().min(1),
  task: z.string().min(1),
  measure: z.enum(PROBE_MEASURES),
  target: z.number(),
  op: z.enum(["<=", ">="]),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").optional(),
});

export const probeFileSchema = z.array(probeSchema);
export type Probe = z.infer<typeof probeSchema>;

/** A probe file is the operator's data, so a malformed one is a usage error rather than a data error. */
export function readProbes(file: string): Probe[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`cannot read probe file ${file}: ${(error as Error).message}`), { code: EXIT.USAGE });
  }
  const parsed = probeFileSchema.safeParse(raw);
  if (!parsed.success) throw Object.assign(new Error(`invalid probe file ${file}: ${z.prettifyError(parsed.error)}`), { code: EXIT.USAGE });
  return parsed.data;
}

export const PROBE_STATUSES = ["HOLDING", "REGRESSED", "NO-DATA"] as const;

export const probesSchema = z.object({
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }),
  rows: z.array(
    z.object({
      probe: z.string(),
      task: z.string(),
      measure: z.enum(PROBE_MEASURES),
      day: z.string(),
      value: z.number().nullable(),
      op: z.enum(["<=", ">="]),
      target: z.number(),
      status: z.enum(PROBE_STATUSES),
    }),
  ),
});

export type ProbesReport = z.infer<typeof probesSchema>;

/** Each local day a measure has data for, with its value; a day missing from the map is NO-DATA. */
type Series = Map<string, number>;

const ACTIVE_MINUTES = "SELECT DISTINCT substr(ts, 1, 16) AS minute FROM request WHERE (@since IS NULL OR ts >= @since) AND (@until IS NULL OR ts < @until)";

/** Local days on which the graph holds any request, so a day with no errors reads as zero rather than as no data. */
function graphDays(db: Db, window: { since?: string; until?: string }): string[] {
  const minutes = db.prepare(ACTIVE_MINUTES).all({ since: window.since ?? null, until: window.until ?? null }) as { minute: string }[];
  return [...new Set(minutes.map((m) => localDay(`${m.minute}:00Z`)))];
}

function countSeries(days: readonly string[], rows: readonly { day: string; count: number }[]): Series {
  const series: Series = new Map(days.map((day) => [day, 0]));
  for (const row of rows) series.set(row.day, (series.get(row.day) ?? 0) + row.count);
  return series;
}

const share = (part: number, whole: number) => Math.round((part / whole) * 1000) / 1000;

function graphSeries(errors: ToolErrorsReport, days: readonly string[]): Record<(typeof GRAPH_MEASURES)[number], Series> {
  const byClass = (cls: ErrorClass) => countSeries(days, errors.byClass.filter((r) => r.class === cls));
  return {
    sleep_blocks: byClass(ERROR_COUNTS.sleep_blocks),
    graphql_ratelimit_errors: byClass(ERROR_COUNTS.graphql_ratelimit_errors),
    wrong_tool_name: byClass(ERROR_COUNTS.wrong_tool_name),
    classifier_merge_denials: countSeries(days, errors.denials.filter((r) => r.reason === MERGE_DENIAL_REASON)),
  };
}

function eventsSeries(trips: RoundTripsReport): Record<(typeof EVENTS_MEASURES)[number], Series> {
  const days = trips.verdictDays;
  return {
    verdict_without_pr_line_share: new Map(days.filter((d) => d.verdicts > 0).map((d) => [d.day, share(d.withoutPrLine, d.verdicts)])),
    first_pass_merge_rate: new Map(days.filter((d) => d.firstVerdicts >= MIN_FIRST_VERDICTS).map((d) => [d.day, share(d.firstPassMerges, d.firstVerdicts)])),
  };
}

const usesAny = (probes: readonly Probe[], measures: readonly string[]) => probes.some((p) => measures.includes(p.measure));

/** Builds only the series the probes name, so a graph-only probe file never needs agent-chat's events and the reverse. */
async function measureSeries(db: Db, report: CostReportOptions, config: MinerConfig, probes: readonly Probe[], ports: ToolErrorsPorts): Promise<Partial<Record<ProbeMeasure, Series>>> {
  const graph = usesAny(probes, GRAPH_MEASURES) ? graphSeries(await answerToolErrors(db, report, [], ports), graphDays(db, report)) : {};
  const events = usesAny(probes, EVENTS_MEASURES) ? eventsSeries(answerRoundTrips(config.eventsDb, report)) : {};
  return { ...graph, ...events };
}

function status(value: number | null, probe: Probe): (typeof PROBE_STATUSES)[number] {
  if (value === null) return "NO-DATA";
  return (probe.op === "<=" ? value <= probe.target : value >= probe.target) ? "HOLDING" : "REGRESSED";
}

/** One row per probe per local day that any named measure has data for, from the probe's `since`. */
export function probeRows(probes: readonly Probe[], series: Partial<Record<ProbeMeasure, Series>>): ProbesReport["rows"] {
  const days = [...new Set(Object.values(series).flatMap((s) => [...s.keys()]))].sort();
  return probes.flatMap((probe) =>
    days
      .filter((day) => !probe.since || day >= probe.since)
      .map((day) => {
        const value = series[probe.measure]?.get(day) ?? null;
        return { probe: probe.id, task: probe.task, measure: probe.measure, day, value, op: probe.op, target: probe.target, status: status(value, probe) };
      }),
  );
}

export function renderProbesText(data: ProbesReport): string {
  const header = `Probes per local day, ${data.window.since ?? "beginning"} to ${data.window.until ?? "now"}`;
  const rows = data.rows.map((r) => `| ${[r.probe, r.measure, r.day, r.value ?? "", `${r.op} ${r.target}`, r.status, r.task].join(" | ")} |`);
  const table = ["| probe | measure | day | value | target | status | task |", "|---|---|---|---:|---|---|---|", ...rows].join("\n");
  return [header, table, LIST_PRICE_CAVEAT].join("\n\n") + "\n";
}

export function probesQuestion(ports: ToolErrorsPorts = DEFAULT_TOOL_ERRORS_PORTS) {
  return defineInsight<{ probes: string }, ProbesReport>({
    id: "Q11",
    name: "probes",
    description: "Named daily measures from Q5 and Q6 against their targets, each day HOLDING, REGRESSED or NO-DATA",
    options: { probes: z.string().min(1).describe(`JSON file of probes: id, task, measure (${PROBE_MEASURES.join(", ")}), target, op (<= or >=), optional since`) },
    flags: { probes: { long: "--probes", description: "probe definitions JSON file" } },
    schema: probesSchema,
    cliOnly: ["probes"],
    async answer(db, report, options, config) {
      refuseSessionScope("probes", report.scope, "; probes measure the whole fleet");
      const probes = readProbes(options.probes);
      const data = { window: { since: report.since ?? null, until: report.until ?? null }, rows: probeRows(probes, await measureSeries(db, report, config, probes, ports)) };
      return { data, text: renderProbesText(data) };
    },
  });
}

export const probes = probesQuestion();
