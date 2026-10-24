import type { WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { isBridgeStage, STAGES, StageRecordSchema, type Check, type StageName, type StageRecord, type Stop } from "./records.js";

/** `reused`: before `--from`, taken from the base run; `cached`: a stage-key hit on a finished child run. */
export type StageStatus = "ran" | "cached" | "reused" | "failed" | "not run";

export interface ReportRow {
  stage: StageName;
  status: StageStatus;
  bridged: boolean;
  wallMs: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  retries: number;
  /** The stage's outputs came from an earlier run instead of being made again. */
  cacheHit: boolean;
  costUnknown: boolean;
  /** The verdict counts, gate and reported apart, so a reported failure never reads as a stopped stage. */
  checks: string;
  checkRows: Check[];
  outputs: Record<string, string>;
  reusedFrom?: string;
  childRunId?: string;
  key?: string;
  notes: string[];
}

/** Another run of the same video, with what it spent itself. */
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
  to: StageName;
  budgetUsd: number;
  stop?: Stop;
  runWallMs: number;
  totals: {
    usd: number; wallMs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
    calls: number; retries: number; cacheHits: number; costUnknown: boolean;
  };
  /** Every other run of this video, oldest first; the video's cost is this run's plus theirs (owner answer Q2 B). */
  videoId: string;
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

function checkText(record: StageRecord): string {
  if (record.checks.length === 0) return "—";
  const failed = record.checks.filter((check) => !check.pass);
  const gates = failed.filter((check) => check.gate === true).length;
  return `${record.checks.length - failed.length} pass, ${gates} gate fail, ${failed.length - gates} reported fail`;
}

function row(stage: StageName, record: StageRecord | undefined, failed: boolean): ReportRow {
  const status: StageStatus = !record ? "not run" : failed ? "failed" : record.reusedFrom ? "reused" : record.cached ? "cached" : "ran";
  const usage = record?.usage;
  return {
    stage, status, bridged: isBridgeStage(stage),
    wallMs: record?.wallMs ?? 0, usd: usage?.usd ?? 0, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens ?? 0, cacheWriteTokens: usage?.cacheWriteTokens ?? 0, calls: usage?.calls ?? 0, retries: record?.retries ?? 0,
    cacheHit: status === "reused" || status === "cached", costUnknown: usage?.costUnknown === true,
    checks: record ? checkText(record) : "—", checkRows: record?.checks ?? [], outputs: record?.outputs ?? {},
    ...(record?.reusedFrom ? { reusedFrom: record.reusedFrom } : {}), ...(record?.childRunId ? { childRunId: record.childRunId } : {}),
    ...(record?.key ? { key: record.key } : {}), notes: record?.notes ?? [],
  };
}

function totals(rows: readonly ReportRow[]): RunReport["totals"] {
  const sum = (pick: (r: ReportRow) => number) => rows.reduce((acc, r) => acc + pick(r), 0);
  return {
    usd: sum((r) => r.usd), wallMs: sum((r) => r.wallMs), inputTokens: sum((r) => r.inputTokens), outputTokens: sum((r) => r.outputTokens),
    cacheReadTokens: sum((r) => r.cacheReadTokens), cacheWriteTokens: sum((r) => r.cacheWriteTokens), calls: sum((r) => r.calls), retries: sum((r) => r.retries),
    cacheHits: rows.filter((r) => r.cacheHit).length, costUnknown: rows.some((r) => r.costUnknown),
  };
}

export interface ReportInput {
  run: WorkflowRun;
  from: StageName;
  to: StageName;
  budgetUsd: number;
  records: readonly StageRecord[];
  failed?: StageRecord;
  stop?: Stop;
  videoId: string;
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
    from: input.from, to: input.to, budgetUsd: input.budgetUsd, ...(input.stop ? { stop: input.stop } : {}),
    runWallMs: end - Date.parse(input.run.startedAt), totals: sums,
    videoId: input.videoId, linked: [...input.linked], videoUsd: sums.usd + input.linked.reduce((acc, run) => acc + run.usd, 0), rows,
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
    `- Stages: ${report.from} to ${report.to}; spend cap ${usd(report.budgetUsd)}`,
    ...(report.stop ? [`- **Stopped at the spend cap before stage ${report.stop.stage}**: ${usd(report.stop.spentUsd)} of ${usd(report.stop.capUsd)}`] : []),
    `- Model spend this run: ${usd(t.usd)}${t.costUnknown ? " (a floor: some spend had no price)" : ""} over ${t.calls} calls, ${t.retries} retries`,
    `- Wall time: ${secs(report.runWallMs)} s for the run, ${secs(t.wallMs)} s inside stages`,
    `- Tokens: ${t.inputTokens} in, ${t.outputTokens} out, ${t.cacheReadTokens} cache read, ${t.cacheWriteTokens} cache written`,
    `- Cache hits: ${t.cacheHits} stages reused from a base run or the stage cache`,
    `- Video ${report.videoId}: ${report.linked.length + 1} runs, total ${usd(report.videoUsd)}`,
    ...report.linked.map((r) => `  - linked run ${r.runId}: ${usd(r.usd)}`),
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
  report.rows.filter((r) => r.notes.length > 0 || r.reusedFrom || r.childRunId).flatMap((r) => [`- **${r.stage}**${origin(r)}`, ...r.notes.map((n) => `  - ${n}`)]);

function origin(r: ReportRow): string {
  if (r.reusedFrom) return ` (reused from ${r.reusedFrom})`;
  if (!r.childRunId) return "";
  return ` (${r.status === "cached" ? "cache hit on" : "child"} run ${r.childRunId}, key ${r.key?.slice(0, 12) ?? "—"})`;
}

/** Every check verdict, per stage; a check without `gate` predates the flag and reads as reported. */
function checkTable(report: RunReport): string[] {
  const lines = report.rows.flatMap((r) =>
    r.checkRows.map((c) => `| ${r.stage} | ${c.name} | ${c.gate === true ? "gate" : "reported"} | ${c.pass ? "pass" : "**fail**"} | ${(c.detail ?? "").replaceAll("|", "\\|")} |`));
  return lines.length === 0 ? ["No checks ran."] : ["| Stage | Check | Role | Verdict | Detail |", "|---|---|---|---|---|", ...lines];
}

export function renderReport(report: RunReport): string {
  return [...header(report), "", "## Stages", "", ...table(report), "", "## Checks", "", ...checkTable(report), "", "## Stage notes", "", ...notes(report), ""].join("\n");
}

export interface CompareRow {
  stage: StageName;
  status: [StageStatus, StageStatus];
  usdDelta: number;
  wallMsDelta: number;
  /** Output names whose sha differs between the two runs, or that only one run made. */
  changed: string[];
}

/** Per stage, the second run against the first: spend and wall time deltas, cache hits and changed output shas. */
export function compareReports(a: RunReport, b: RunReport): CompareRow[] {
  return a.rows.map((left, i) => {
    const right = b.rows[i]!;
    const names = [...new Set([...Object.keys(left.outputs), ...Object.keys(right.outputs)])].sort();
    return {
      stage: left.stage, status: [left.status, right.status], usdDelta: right.usd - left.usd, wallMsDelta: right.wallMs - left.wallMs,
      changed: names.filter((name) => left.outputs[name] !== right.outputs[name]),
    };
  });
}

export function renderCompare(a: RunReport, b: RunReport): string {
  const rows = compareReports(a, b);
  const signed = (value: number, text: string) => `${value > 0 ? "+" : ""}${text}`;
  return [
    `## Compare: ${b.runId} against ${a.runId}`,
    "",
    `- Model spend ${usd(a.totals.usd)} → ${usd(b.totals.usd)}; wall in stages ${secs(a.totals.wallMs)} s → ${secs(b.totals.wallMs)} s`,
    `- Cache hits in ${b.runId}: ${rows.filter((r) => r.status[1] === "cached" || r.status[1] === "reused").map((r) => r.stage).join(", ") || "none"}`,
    "",
    "| Stage | Status | Δ USD | Δ wall s | Changed outputs |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.stage} | ${r.status[0]} → ${r.status[1]} | ${signed(r.usdDelta, usd(r.usdDelta))} | ${signed(r.wallMsDelta, secs(r.wallMsDelta))} | ${r.changed.join(", ") || "—"} |`),
    "",
  ].join("\n");
}
