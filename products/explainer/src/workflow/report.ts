import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { isBridgeStage, STAGES, StageRecordSchema, type StageName, type StageRecord, type Stop } from "./records.js";

export type StageStatus = "ran" | "reused" | "failed" | "not run";

export interface ReportRow {
  stage: StageName;
  status: StageStatus;
  bridged: boolean;
  wallMs: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  calls: number;
  retries: number;
  /** The stage's outputs came from an earlier run instead of being made again. */
  cacheHit: boolean;
  costUnknown: boolean;
  checks: string;
  outputs: Record<string, string>;
  reusedFrom?: string;
  notes: string[];
}

/** A run this one was started from, with what it spent itself. */
export interface LinkedRun {
  runId: string;
  usd: number;
}

export interface RunReport {
  schema: "explainer-run-report/v1";
  runId: string;
  status: string;
  error?: string;
  from: StageName;
  budgetUsd: number;
  stop?: Stop;
  runWallMs: number;
  totals: { usd: number; wallMs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; calls: number; retries: number; cacheHits: number; costUnknown: boolean };
  /** The base runs, nearest first; the video's cost is this run's plus theirs (owner answer Q2 B). */
  linked: LinkedRun[];
  videoUsd: number;
  rows: ReportRow[];
}

const CodeRecordSchema = z.object({ result: StageRecordSchema });

/** The stage records a run's code steps stored, in stage order. */
export function stageRecords(run: WorkflowRun): StageRecord[] {
  const records = Object.values(run.stepResults)
    .filter((result) => result.stepId.startsWith("stage:") && result.output !== undefined)
    .map((result) => CodeRecordSchema.parse(JSON.parse(result.output!)).result);
  return records.sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
}

/** What a run spent itself: reused stages cost nothing here, and a failed stage still counts. */
export const ownUsd = (records: readonly StageRecord[]): number => records.reduce((sum, record) => sum + record.usage.usd, 0);

const checkText = (record: StageRecord): string => {
  const failed = record.checks.filter((check) => !check.pass).length;
  return record.checks.length === 0 ? "—" : `${record.checks.length - failed} pass, ${failed} fail`;
};

function row(stage: StageName, record: StageRecord | undefined, failed: boolean): ReportRow {
  const status: StageStatus = !record ? "not run" : failed ? "failed" : record.reusedFrom ? "reused" : "ran";
  const usage = record?.usage;
  return {
    stage, status, bridged: isBridgeStage(stage),
    wallMs: record?.wallMs ?? 0, usd: usage?.usd ?? 0, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0, calls: usage?.calls ?? 0, retries: record?.retries ?? 0,
    cacheHit: status === "reused", costUnknown: usage?.costUnknown === true,
    checks: record ? checkText(record) : "—", outputs: record?.outputs ?? {},
    ...(record?.reusedFrom ? { reusedFrom: record.reusedFrom } : {}), notes: record?.notes ?? [],
  };
}

function totals(rows: readonly ReportRow[]): RunReport["totals"] {
  const sum = (pick: (r: ReportRow) => number) => rows.reduce((acc, r) => acc + pick(r), 0);
  return {
    usd: sum((r) => r.usd), wallMs: sum((r) => r.wallMs), inputTokens: sum((r) => r.inputTokens), outputTokens: sum((r) => r.outputTokens),
    cacheReadTokens: sum((r) => r.cacheReadTokens), calls: sum((r) => r.calls), retries: sum((r) => r.retries),
    cacheHits: rows.filter((r) => r.cacheHit).length, costUnknown: rows.some((r) => r.costUnknown),
  };
}

export interface ReportInput {
  run: WorkflowRun;
  from: StageName;
  budgetUsd: number;
  records: readonly StageRecord[];
  failed?: StageRecord;
  stop?: Stop;
  linked: readonly LinkedRun[];
}

export function buildReport(input: ReportInput): RunReport {
  const all = input.failed ? [...input.records, input.failed] : input.records;
  const rows = STAGES.map((stage) => row(stage, all.find((r) => r.stage === stage), input.failed?.stage === stage));
  const sums = totals(rows);
  const end = input.run.completedAt ? Date.parse(input.run.completedAt) : Date.now();
  return {
    schema: "explainer-run-report/v1", runId: input.run.id, status: input.run.status,
    ...(input.run.error ? { error: input.run.error } : {}),
    from: input.from, budgetUsd: input.budgetUsd, ...(input.stop ? { stop: input.stop } : {}),
    runWallMs: end - Date.parse(input.run.startedAt), totals: sums,
    linked: [...input.linked], videoUsd: sums.usd + input.linked.reduce((acc, run) => acc + run.usd, 0), rows,
  };
}

const usd = (value: number): string => `$${value.toFixed(4)}`;
const secs = (ms: number): string => (ms / 1000).toFixed(1);
const share = (part: number, whole: number): string => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "—");
const shas = (outputs: Record<string, string>): string => Object.entries(outputs).map(([name, sha]) => `${name} ${sha.slice(0, 12)}`).join("<br>") || "—";

function header(report: RunReport): string[] {
  const t = report.totals;
  return [
    `# Run report: ${report.runId}`,
    "",
    `- Status: **${report.status}**${report.error ? ` (${report.error})` : ""}`,
    `- Started from stage: ${report.from}; spend cap ${usd(report.budgetUsd)}`,
    ...(report.stop ? [`- **Stopped at the spend cap before stage ${report.stop.stage}**: ${usd(report.stop.spentUsd)} of ${usd(report.stop.capUsd)}`] : []),
    `- Model spend this run: ${usd(t.usd)}${t.costUnknown ? " (a floor: some spend had no price)" : ""} over ${t.calls} calls, ${t.retries} retries`,
    `- Wall time: ${secs(report.runWallMs)} s for the run, ${secs(t.wallMs)} s inside stages`,
    `- Tokens: ${t.inputTokens} in, ${t.outputTokens} out, ${t.cacheReadTokens} cache read`,
    `- Cache hits: ${t.cacheHits} stages reused from an earlier run`,
    ...(report.linked.length > 0 ? [`- Linked runs: ${report.linked.map((r) => `${r.runId} (${usd(r.usd)})`).join(", ")}; video total ${usd(report.videoUsd)}`] : []),
    `- Bridged stages (today's template commands through the host's bridge file, not yet ported): ${report.rows.filter((r) => r.bridged).map((r) => r.stage).join(", ")}`,
  ];
}

function table(report: RunReport): string[] {
  const t = report.totals;
  const cells = (r: ReportRow): (string | number)[] => [
    r.stage, r.status, r.bridged ? "**bridge**" : "in-process", secs(r.wallMs), share(r.wallMs, t.wallMs), usd(r.usd), share(r.usd, t.usd),
    r.inputTokens, r.outputTokens, r.cacheReadTokens, r.calls, r.retries, r.cacheHit ? "yes" : "no", r.checks, shas(r.outputs),
  ];
  const lines = report.rows.map((r) => `| ${cells(r).join(" | ")} |`);
  return [
    "| Stage | Status | Path | Wall s | Wall % | USD | USD % | Tokens in | Tokens out | Cache read | Calls | Retries | Cache hit | Checks | Output shas |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...lines,
    `| **total** | | | ${secs(t.wallMs)} | | ${usd(t.usd)} | | ${t.inputTokens} | ${t.outputTokens} | ${t.cacheReadTokens} | ${t.calls} | ${t.retries} | ${t.cacheHits} | | |`,
  ];
}

const notes = (report: RunReport): string[] =>
  report.rows.filter((r) => r.notes.length > 0 || r.reusedFrom).flatMap((r) => [`- **${r.stage}**${r.reusedFrom ? ` (reused from ${r.reusedFrom})` : ""}`, ...r.notes.map((n) => `  - ${n}`)]);

export function renderReport(report: RunReport): string {
  return [...header(report), "", "## Stages", "", ...table(report), "", "## Stage notes", "", ...notes(report), ""].join("\n");
}
