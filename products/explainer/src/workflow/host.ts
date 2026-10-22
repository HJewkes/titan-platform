import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { routedRunner, WorkflowRunStore, WorkflowRuntime, workflowMigration, workflowOwnershipMigration, type WorkflowEvent, type WorkflowRun } from "@titan-design/workflow";
import { JudgeConfigSchema, type JudgeConfig } from "../eval-harness.js";
import type { L0Check } from "../eval-l0.js";
import { MAX_REWRITE_ROUNDS } from "../rewrite-plan.js";
import { artifactMigration, ArtifactStore } from "./artifacts.js";
import { readBridgeFile, spawnExec, type BridgeExec } from "./bridge.js";
import type { HarnessFor, RunnerFor } from "./model-stages.js";
import { RunPlanSchema, stageRoute, VIDEO_WORKFLOW, VIDEO_WORKFLOW_VERSION, videoWorkflow, type RunPlan } from "./pipeline.js";
import { RUN_INPUTS, STAGES, StageRecordSchema, StopSchema, type StageName, type StageRecord } from "./records.js";
import { buildReport, ownUsd, renderReport, stageRecords, type LinkedRun, type RunReport } from "./report.js";
import { readJson, runPaths, writeJson, writeText } from "./run-dir.js";

export interface RunHost {
  /** Run state, the artifact store, run directories and the bridge host file `bridge.json`. */
  dataDir: string;
  /** Model seams; tests pass fakes, production uses `agentRunner` and the judge harness. */
  runnerFor?: RunnerFor;
  harnessFor?: HarnessFor;
  /** The L0 checks the eval stage runs; all of them by default. */
  evalChecks?: readonly L0Check[];
  /** Runs a bridged command; tests pass a fake. */
  exec?: BridgeExec;
  leaseMs?: number;
  onEvent?: (event: WorkflowEvent) => void;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface RunRequest {
  /** spine.md and facts.md; required from `script`, and when given later they replace the base run's. */
  spine?: string;
  facts?: string;
  from?: StageName;
  /** The run whose records stand in for the stages before `from`; the latest run by default. */
  base?: string;
  budgetUsd?: number;
  scriptModel?: string;
  judge?: JudgeConfig;
  rounds?: number;
}

export interface RunOutcome {
  runId: string;
  status: string;
  error?: string;
  report: RunReport;
  reportPath: string;
}

/** A high runaway backstop, not a per-video budget (owner answer Q3 A). */
export const DEFAULT_BUDGET_USD = 20;
export const DEFAULT_SCRIPT_MODEL = "sonnet";
export const DEFAULT_JUDGE: JudgeConfig = JudgeConfigSchema.parse({ provider: "claude-print", model: "sonnet" });
const DEFAULT_LEASE_MS = 120_000;

function openState(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(path.join(dataDir, "state.sqlite3"));
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4), artifactMigration(5)]);
  return db;
}

const planOf = (run: WorkflowRun): RunPlan => RunPlanSchema.parse(JSON.parse(run.params.plan ?? "{}"));

function latestRun(store: WorkflowRunStore): WorkflowRun | undefined {
  const runs = store.listByStatus(["completed", "failed", "cancelled"]).filter((run) => run.workflowName === VIDEO_WORKFLOW);
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

/** Every record the run holds, a failed stage's included, so a resume can start where it broke off. */
function allRecords(dataDir: string, run: WorkflowRun): StageRecord[] {
  const failed = STAGES.map((stage) => readJson(runPaths(dataDir, run.id).failed(stage), StageRecordSchema)).filter((r) => r !== undefined);
  return [...stageRecords(run), ...failed];
}

function inputArtifacts(request: RunRequest, store: ArtifactStore): Record<string, string> {
  const files: Record<(typeof RUN_INPUTS)[number], string | undefined> = { spine: request.spine, facts: request.facts };
  return Object.fromEntries(Object.entries(files).filter(([, file]) => file !== undefined).map(([name, file]) => [name, store.putText(readFileSync(file!, "utf8"), name, { runId: "input", stage: "input" })]));
}

function reusedFromBase(base: WorkflowRun, from: StageName): { reused: StageRecord[]; artifacts: Record<string, string> } {
  const records = stageRecords(base);
  const before = STAGES.slice(0, STAGES.indexOf(from));
  const reused = before.map((stage) => {
    const found = records.find((record) => record.stage === stage);
    if (!found) throw new Error(`base run ${base.id} has no completed ${stage} stage; start from ${stage} or earlier`);
    return found;
  });
  const artifacts = reused.reduce<Record<string, string>>((acc, record) => ({ ...acc, ...record.outputs }), { ...planOf(base).artifacts });
  return { reused, artifacts };
}

function buildPlan(request: RunRequest, db: Db, store: ArtifactStore): RunPlan {
  const from = request.from ?? "script";
  const inputs = inputArtifacts(request, store);
  const settings = {
    budgetUsd: request.budgetUsd ?? DEFAULT_BUDGET_USD, scriptModel: request.scriptModel ?? DEFAULT_SCRIPT_MODEL,
    judge: request.judge ?? DEFAULT_JUDGE, rounds: request.rounds ?? MAX_REWRITE_ROUNDS,
  };
  const base = from === "script" && !request.base ? undefined : findBase(new WorkflowRunStore(db), request.base, from);
  const fromBase = base ? reusedFromBase(base, from) : { reused: [], artifacts: {} };
  const artifacts = { ...fromBase.artifacts, ...inputs };
  const missing = RUN_INPUTS.filter((name) => artifacts[name] === undefined);
  if (missing.length > 0) throw new Error(`this run needs ${missing.map((m) => `--${m}`).join(" and ")}`);
  return { from, ...(base ? { baseRunId: base.id } : {}), artifacts, reused: fromBase.reused, ...settings };
}

function findBase(runs: WorkflowRunStore, id: string | undefined, from: StageName): WorkflowRun {
  const base = id ? runs.get(id) : latestRun(runs);
  if (base?.workflowName === VIDEO_WORKFLOW) return base;
  throw new Error(id ? `no ${VIDEO_WORKFLOW} run ${id}` : `no earlier ${VIDEO_WORKFLOW} run to start --from ${from} on; pass --base`);
}

function linkedRuns(dataDir: string, runs: WorkflowRunStore, baseRunId: string | undefined): LinkedRun[] {
  const linked: LinkedRun[] = [];
  for (let id = baseRunId; id !== undefined && !linked.some((r) => r.runId === id);) {
    const run = runs.get(id);
    if (!run) break;
    linked.push({ runId: id, usd: ownUsd(allRecords(dataDir, run)) });
    id = planOf(run).baseRunId;
  }
  return linked;
}

/** Folds a run's records into `run-report.md` and `run-report.json` in its run directory. */
export function writeReport(runId: string, host: Pick<RunHost, "dataDir">): { report: RunReport; reportPath: string } {
  const db = openState(host.dataDir);
  try {
    const runs = new WorkflowRunStore(db);
    const run = runs.get(runId);
    if (!run || run.workflowName !== VIDEO_WORKFLOW) throw new Error(`no ${VIDEO_WORKFLOW} run ${runId}`);
    const plan = planOf(run);
    const paths = runPaths(host.dataDir, runId);
    const failedStage = STAGES.find((stage) => readJson(paths.failed(stage), StageRecordSchema) !== undefined);
    const failed = failedStage ? readJson(paths.failed(failedStage), StageRecordSchema) : undefined;
    const stop = readJson(paths.stop, StopSchema);
    const report = buildReport({ run, from: plan.from, budgetUsd: plan.budgetUsd, records: stageRecords(run), ...(failed ? { failed } : {}), ...(stop ? { stop } : {}), linked: linkedRuns(host.dataDir, runs, plan.baseRunId) });
    writeJson(paths.reportJson, report);
    writeText(paths.reportMd, renderReport(report));
    return { report, reportPath: paths.reportMd };
  } finally {
    db.close();
  }
}

function newRuntime(db: Db, plan: RunPlan, host: RunHost): WorkflowRuntime {
  const store = new ArtifactStore(host.dataDir, db);
  let bridge: ReturnType<typeof readBridgeFile> | undefined;
  const route = stageRoute({
    dataDir: host.dataDir, store, plan, bridge: () => (bridge ??= readBridgeFile(host.dataDir)), exec: host.exec ?? spawnExec,
    ...(host.runnerFor ? { runnerFor: host.runnerFor } : {}), ...(host.harnessFor ? { harnessFor: host.harnessFor } : {}), ...(host.evalChecks ? { evalChecks: host.evalChecks } : {}),
    ...(host.signal ? { signal: host.signal } : {}), ...(host.now ? { now: host.now } : {}),
  });
  const runner = routedRunner([route]);
  runner.assertRoutes(VIDEO_WORKFLOW, STAGES.map((stage) => `stage:${stage}`));
  const runtime = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, leaseMs: host.leaseMs ?? DEFAULT_LEASE_MS, ...(host.onEvent ? { onEvent: host.onEvent } : {}) });
  runtime.register(VIDEO_WORKFLOW, videoWorkflow(plan, host.dataDir), { version: VIDEO_WORKFLOW_VERSION });
  return runtime;
}

async function settle(runtime: WorkflowRuntime, runId: string, host: RunHost): Promise<WorkflowRun> {
  const stop = () => runtime.shutdown();
  host.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (host.signal?.aborted) stop();
    return await runtime.wait(runId);
  } finally {
    host.signal?.removeEventListener("abort", stop);
  }
}

function outcome(run: WorkflowRun, host: RunHost): RunOutcome {
  return { runId: run.id, status: run.status, ...(run.error ? { error: run.error } : {}), ...writeReport(run.id, host) };
}

/** Starts one `explainer-video` run, drives it to its end or its first failure, and writes its report. */
export async function runVideo(request: RunRequest, host: RunHost): Promise<RunOutcome> {
  const db = openState(host.dataDir);
  try {
    const plan = buildPlan(request, db, new ArtifactStore(host.dataDir, db));
    const runtime = newRuntime(db, plan, host);
    const runId = runtime.start(VIDEO_WORKFLOW, { plan: JSON.stringify(plan) });
    const run = await settle(runtime, runId, host);
    return outcome(run, host);
  } finally {
    db.close();
  }
}

/** The first stage of `run` with no completed record: where a stopped or failed run picks up. */
function resumeStage(dataDir: string, run: WorkflowRun): StageName {
  const done = new Set(stageRecords(run).map((record) => record.stage));
  const stage = STAGES.find((s) => !done.has(s));
  if (!stage) throw new Error(`run ${run.id} finished every stage; nothing to resume`);
  return readJson(runPaths(dataDir, run.id).stop, StopSchema)?.stage ?? stage;
}

/**
 * Picks a run up. A crashed run (still `running` after its lease) is claimed and driven on, replaying its finished
 * stages; a run that stopped at its cap or failed starts a new run from its first unfinished stage, linked to it.
 */
export async function resumeVideo(runId: string, host: RunHost, overrides: Pick<RunRequest, "budgetUsd"> = {}): Promise<RunOutcome> {
  const db = openState(host.dataDir);
  let run: WorkflowRun | undefined;
  try {
    run = new WorkflowRunStore(db).get(runId);
    if (!run || run.workflowName !== VIDEO_WORKFLOW) throw new Error(`no ${VIDEO_WORKFLOW} run ${runId}`);
    if (run.status === "running") {
      const runtime = newRuntime(db, planOf(run), host);
      const claimed = await runtime.hydrate({ exclude: new Set(runtime.list().map((r) => r.id).filter((id) => id !== runId)) });
      if (!claimed.includes(runId)) throw new Error(`run ${runId} is still leased by another process; retry after ${(host.leaseMs ?? DEFAULT_LEASE_MS) / 1000}s`);
      return outcome(await settle(runtime, runId, host), host);
    }
  } finally {
    db.close();
  }
  const plan = planOf(run);
  return runVideo({ from: resumeStage(host.dataDir, run), base: runId, budgetUsd: overrides.budgetUsd ?? plan.budgetUsd, scriptModel: plan.scriptModel, judge: plan.judge, rounds: plan.rounds }, host);
}
