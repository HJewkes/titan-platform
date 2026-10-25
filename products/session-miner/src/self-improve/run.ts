import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import {
  WorkflowRuntime,
  agentRunner,
  routedRunner,
  workflowMigration,
  workflowOwnershipMigration,
  type AgentRunnerOptions,
  type LegacyStepRunner,
  type StepRunOutcome,
  type WorkflowRun,
} from "@titan-design/workflow";
import { DAILY_WORKFLOW, DailySummarySchema, SUMMARY_FILE, dailyWorkflow, listChunks, promptPath, type DailySummary } from "./daily.js";
import { PROMPT_FAMILIES, type PromptFamily } from "./families.js";

/** The process boundary: each family's calls go through the runner it returns. Tests pass a fake. */
export type RunnerFor = (options: AgentRunnerOptions) => LegacyStepRunner;

export interface DailyOptions {
  chunks: string;
  prompts: string;
  out: string;
  maxBudgetUsd: number;
}

export interface DailyHost {
  /** Holds the run state; a rerun over the same chunk and out dirs resumes the run recorded here. */
  stateDir: string;
  runnerFor?: RunnerFor;
  families?: readonly PromptFamily[];
  leaseMs?: number;
  /** Stops driving the run as a kill would, but releases its lease at once so a rerun can claim it. */
  signal?: AbortSignal;
}

export interface DailyResult {
  runId: string;
  status: WorkflowRun["status"];
  /** Model calls this invocation made; finished chunks replay from the record and make none. */
  newCalls: number;
  summary?: DailySummary;
  error?: string;
}

export const DEFAULT_MAX_BUDGET_USD = 3;
const DEFAULT_LEASE_MS = 120_000;
const ALL_STATUSES: WorkflowRun["status"][] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];

/** A model answer that fails the family's output schema; recorded, so a resume does not pay for it twice. */
const SCHEMA_INVALID_ANSWER = "schema_invalid";

/** Why the inputs cannot run, or undefined: both dirs exist and every family with chunks has its prompt. */
export function checkInputs(options: DailyOptions, families: readonly PromptFamily[] = PROMPT_FAMILIES): string | undefined {
  for (const [flag, dir] of [["--chunks", options.chunks], ["--prompts", options.prompts]] as const) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return `${flag} ${dir} is not a directory`;
  }
  const withChunks = new Set(listChunks(options.chunks, families).map((chunk) => chunk.family));
  const missing = families.filter((family) => withChunks.has(family.id) && !existsSync(promptPath(options.prompts, family)));
  return missing.length === 0 ? undefined : `no prompt file for ${missing.map((family) => `${family.id}.md`).join(", ")} in ${options.prompts}`;
}

function familyRunner(family: PromptFamily, runnerFor: RunnerFor, calls: { count: number }): LegacyStepRunner {
  const live = runnerFor({
    cwd: tmpdir(),
    maxTurns: 1,
    maxBudgetUsd: family.callBudgetUsd,
    defaults: { harness: "claude-print", model: family.model, outputSchema: family.outputSchema },
  });
  return {
    async run(input): Promise<StepRunOutcome> {
      calls.count += 1;
      const outcome = await live.run(input);
      if (outcome.ok || outcome.code !== "schema_invalid") return outcome;
      return { ok: true, output: SCHEMA_INVALID_ANSWER, ...(outcome.usage ? { usage: outcome.usage } : {}) };
    },
  };
}

function openState(stateDir: string): Db {
  mkdirSync(stateDir, { recursive: true });
  const db = openDatabase(path.join(stateDir, "state.sqlite3"));
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

function newRuntime(db: Db, host: DailyHost, calls: { count: number }): WorkflowRuntime {
  const families = host.families ?? PROMPT_FAMILIES;
  const runnerFor = host.runnerFor ?? agentRunner;
  const runner = routedRunner(families.map((family) => ({ match: family.id, runner: familyRunner(family, runnerFor, calls), onRestart: "repeat" as const })));
  const runtime = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, leaseMs: host.leaseMs ?? DEFAULT_LEASE_MS });
  runtime.register(DAILY_WORKFLOW, dailyWorkflow(families));
  return runtime;
}

function priorRun(runtime: WorkflowRuntime, options: DailyOptions): WorkflowRun | undefined {
  return runtime
    .list(ALL_STATUSES)
    .filter((run) => run.workflowName === DAILY_WORKFLOW && run.params.chunks === options.chunks && run.params.out === options.out)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

/** Resumes the unfinished run over these dirs, reports a finished one as it stands, or starts a fresh one. */
async function driveRun(runtime: WorkflowRuntime, options: DailyOptions, host: DailyHost): Promise<string> {
  const prior = priorRun(runtime, options);
  if (!prior || prior.status === "failed" || prior.status === "cancelled") {
    return runtime.start(DAILY_WORKFLOW, { chunks: options.chunks, prompts: options.prompts, out: options.out, maxBudgetUsd: String(options.maxBudgetUsd) });
  }
  if (prior.status === "completed") return prior.id;
  const others = new Set(runtime.list().map((run) => run.id).filter((id) => id !== prior.id));
  const claimed = await runtime.hydrate({ exclude: others });
  if (!claimed.includes(prior.id)) throw new Error(`run ${prior.id} is ${prior.status} and held by another process; retry after ${(host.leaseMs ?? DEFAULT_LEASE_MS) / 1000}s`);
  return prior.id;
}

/** Runs, or resumes, the daily classification stage over one chunk dir. Paths are resolved, so a rerun from elsewhere still matches. */
export async function runSelfImproveDaily(input: DailyOptions, host: DailyHost): Promise<DailyResult> {
  const options = { ...input, chunks: path.resolve(input.chunks), prompts: path.resolve(input.prompts), out: path.resolve(input.out) };
  const db = openState(host.stateDir);
  const calls = { count: 0 };
  const runtime = newRuntime(db, host, calls);
  const stop = () => runtime.shutdown();
  host.signal?.addEventListener("abort", stop, { once: true });
  try {
    const runId = await driveRun(runtime, options, host);
    if (host.signal?.aborted) stop();
    const run = await runtime.wait(runId);
    const summary = run.status === "completed" ? readSummary(options.out) : undefined;
    return { runId, status: run.status, newCalls: calls.count, ...(summary ? { summary } : {}), ...(run.error ? { error: run.error } : {}) };
  } finally {
    host.signal?.removeEventListener("abort", stop);
    runtime.shutdown();
    db.close();
  }
}

function readSummary(outDir: string): DailySummary | undefined {
  const file = path.join(outDir, SUMMARY_FILE);
  return existsSync(file) ? DailySummarySchema.parse(JSON.parse(readFileSync(file, "utf8"))) : undefined;
}
