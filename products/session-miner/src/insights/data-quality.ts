import { readFileSync } from "node:fs";
import {
  DEFAULT_DONE_OUTCOMES,
  DEFAULT_MERGED_OUTCOMES,
  assignmentSchema,
  costPerOutcome,
  costReport,
  costReportSchema,
  renderCostReportSections,
  type Assignment,
  type CostReport,
  type CostReportOptions,
} from "@titan-design/session-analytics";
import { KIT } from "@titan-design/session-graph";
import { EXTRACT_VERSION, discoverTranscripts } from "@titan-design/session-read";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { defineInsight } from "./define.js";

export const DATA_QUALITY_FAULTS = [
  "graph-stale",
  "transcripts-unindexed",
  "facet-backlog",
  "unpriced-model",
  "assignment-invalid",
  "assignment-outcome-unknown",
  "agent-unmatched",
] as const;

/** `error`: the numbers it touches are wrong, so no claim rests on them; `warn`: they are incomplete. */
const faultSchema = z.object({
  fault: z.enum(DATA_QUALITY_FAULTS),
  severity: z.enum(["error", "warn"]),
  evidence: z.string(),
  suggestedTitle: z.string(),
});

export type DataQualityFault = z.infer<typeof faultSchema>;

export const dataQualitySchema = costReportSchema.pick({ window: true, priceTableVersion: true, totals: true, coverage: true }).extend({
  asOf: z.string(),
  maxLagMinutes: z.number(),
  newestRequest: z.string().nullable(),
  faults: z.array(faultSchema),
});

export type DataQualityReport = z.infer<typeof dataQualitySchema>;

const DEFAULT_MAX_LAG_MINUTES = 60;

/** A parsed `--assignments` file: the lines that failed, and the rows that passed. */
export interface AssignmentFile {
  invalidLines: number[];
  assignments: Assignment[];
}

/** One JSONL row per line; a line that is not JSON or not an assignment is counted by its 1-based number, never thrown. */
export function parseAssignments(text: string): AssignmentFile {
  const invalidLines: number[] = [];
  const assignments: Assignment[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const parsed = assignmentSchema.safeParse(parseJson(line));
    if (parsed.success) assignments.push(parsed.data);
    else invalidLines.push(index + 1);
  });
  return { invalidLines, assignments };
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export interface GraphFacts {
  asOf: string;
  maxLagMinutes: number;
  newestRequest: string | null;
  unindexed: readonly string[];
  report: Pick<CostReport, "coverage" | "unpricedModels">;
}

/** The faults the graph itself shows: staleness, unindexed transcripts, facet backlog and unpriced models. */
export function graphFaults(facts: GraphFacts): DataQualityFault[] {
  const faults: DataQualityFault[] = [];
  const lagMinutes = facts.newestRequest === null ? null : (Date.parse(facts.asOf) - Date.parse(facts.newestRequest)) / 60_000;
  if (lagMinutes === null || lagMinutes > facts.maxLagMinutes) {
    const evidence = lagMinutes === null ? `no request before ${facts.asOf}` : `newest request ${facts.newestRequest} is ${Math.round(lagMinutes)} min before ${facts.asOf}`;
    faults.push({ fault: "graph-stale", severity: "error", evidence: `${evidence}; allowed lag ${facts.maxLagMinutes} min`, suggestedTitle: "Session graph is stale: run titan-miner refresh and check the daemon" });
  }
  if (facts.unindexed.length > 0) {
    const evidence = `${facts.unindexed.length} discovered transcripts not indexed, first ${facts.unindexed[0]}`;
    faults.push({ fault: "transcripts-unindexed", severity: "warn", evidence, suggestedTitle: "Index the transcripts the miner discovered but never indexed" });
  }
  const { facetBacklog } = facts.report.coverage;
  if (facetBacklog > 0) {
    faults.push({ fault: "facet-backlog", severity: "warn", evidence: `${facetBacklog} transcripts below audit facet v${EXTRACT_VERSION}`, suggestedTitle: "Drain the audit facet backlog" });
  }
  for (const { model, requests } of facts.report.unpricedModels) {
    faults.push({ fault: "unpriced-model", severity: "error", evidence: `${requests} requests on ${model}`, suggestedTitle: `Add ${model} to the session-analytics price table` });
  }
  return faults;
}

/** Faults in an assignments file: bad lines, outcomes outside `knownOutcomes`, and agents with no session in the graph. */
export function assignmentFaults(file: AssignmentFile, knownOutcomes: ReadonlySet<string>, unmatchedAgents: readonly string[]): DataQualityFault[] {
  const faults: DataQualityFault[] = [];
  if (file.invalidLines.length > 0) {
    const evidence = `${file.invalidLines.length} lines fail the assignment schema: ${file.invalidLines.slice(0, 10).join(", ")}`;
    faults.push({ fault: "assignment-invalid", severity: "warn", evidence, suggestedTitle: "Fix the dispatch adapter lines that fail the assignment schema" });
  }
  const unknown = countBy(file.assignments.filter((a) => a.outcome === null || !knownOutcomes.has(a.outcome)), (a) => a.outcome ?? "(null)");
  if (unknown.size > 0) {
    const evidence = [...unknown].map(([outcome, n]) => `${JSON.stringify(outcome)} x${n}`).join(", ");
    faults.push({ fault: "assignment-outcome-unknown", severity: "warn", evidence, suggestedTitle: "Normalise dispatch outcomes into the known outcome set" });
  }
  if (unmatchedAgents.length > 0) {
    const evidence = `${unmatchedAgents.length} agents with no session: ${unmatchedAgents.slice(0, 10).join(", ")}`;
    faults.push({ fault: "agent-unmatched", severity: "warn", evidence, suggestedTitle: "Join dispatched agents to their sessions in the graph" });
  }
  return faults;
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return new Map([...counts].sort(([a], [b]) => a.localeCompare(b)));
}

function readNewestRequest(db: Db, asOf: string): string | null {
  return (db.prepare("SELECT MAX(ts) AS ts FROM request WHERE ts < ?").get(asOf) as { ts: string | null }).ts;
}

/** Compared by path, not by count, since Codex sources are indexed without being discovered here. */
async function discoverUnindexed(db: Db, corpusRoot: string): Promise<{ discovered: number; unindexed: string[] }> {
  const indexed = new Set((db.prepare(`SELECT source_key FROM "${KIT.watermark}"`).all() as { source_key: string }[]).map((row) => row.source_key));
  const discovered = (await discoverTranscripts(corpusRoot)).map((t) => t.displayPath);
  return { discovered: discovered.length, unindexed: discovered.filter((key) => !indexed.has(key)) };
}

function readAssignmentFaults(db: Db, report: CostReportOptions, path: string, extraOutcomes: readonly string[]): DataQualityFault[] {
  const file = parseAssignments(readFileSync(path, "utf8"));
  const known = new Set([...DEFAULT_MERGED_OUTCOMES, ...DEFAULT_DONE_OUTCOMES, ...extraOutcomes]);
  const { unmatchedAgents } = costPerOutcome(db, file.assignments, { since: report.since ?? null, until: report.until ?? null });
  return assignmentFaults(file, known, unmatchedAgents);
}

export function renderDataQualityText(data: DataQualityReport, full: CostReport): string {
  const lines = data.faults.map((f) => `${f.severity.toUpperCase()} ${f.fault}: ${f.evidence}\n  task: ${f.suggestedTitle}`);
  const body = lines.length === 0 ? "Data quality: no faults" : [`Data quality: ${lines.length} faults`, ...lines].join("\n");
  return `${body}\n\n${renderCostReportSections(full, [])}`;
}

interface DataQualityOptions {
  maxLag?: number;
  assignments?: string;
  knownOutcome?: string[];
}

export const dataQuality = defineInsight<DataQualityOptions, DataQualityReport>({
  id: "Q12",
  name: "data-quality",
  description: "Faults to clear before any analysis: stale graph, unindexed transcripts, facet backlog, unpriced models and bad assignments",
  options: {
    maxLag: z.number().positive().optional().describe(`minutes the newest request may trail --until (or now); default ${DEFAULT_MAX_LAG_MINUTES}`),
    assignments: z.string().min(1).optional().describe("JSONL file of assignments to check against the schema, the outcome set and the graph"),
    knownOutcome: z.array(z.string().min(1)).optional().describe("outcome words to accept beyond merged and done"),
  },
  flags: {
    maxLag: { long: "--max-lag", description: "allowed graph lag in minutes" },
    assignments: { long: "--assignments", description: "assignments JSONL path" },
    knownOutcome: { long: "--known-outcome", description: "accepted outcome word (repeatable)" },
  },
  schema: dataQualitySchema,
  cliOnly: ["assignments"],
  async answer(db, report, options, config) {
    const asOf = report.until ?? new Date().toISOString();
    const maxLagMinutes = options.maxLag ?? DEFAULT_MAX_LAG_MINUTES;
    const { discovered, unindexed } = await discoverUnindexed(db, config.corpusRoot);
    const full = costReport(db, { ...report, facetVersion: EXTRACT_VERSION, transcriptsDiscovered: discovered });
    const newestRequest = readNewestRequest(db, asOf);
    const faults = graphFaults({ asOf, maxLagMinutes, newestRequest, unindexed, report: full });
    if (options.assignments) faults.push(...readAssignmentFaults(db, report, options.assignments, options.knownOutcome ?? []));
    const { window, priceTableVersion, totals, coverage } = full;
    const data = { window, priceTableVersion, totals, coverage, asOf, maxLagMinutes, newestRequest, faults };
    return { data, text: renderDataQualityText(data, full) };
  },
});
