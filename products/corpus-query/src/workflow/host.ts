import { mkdirSync } from "node:fs";
import path from "node:path";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { WorkflowRunStore, WorkflowRuntime, workflowMigration, workflowOwnershipMigration, type StepRunner, type WorkflowEvent } from "@titan-design/workflow";
import { buildJudgePrefix, CONFIRM_ROLE, SCREEN_ROLE } from "../judge/index.js";
import { QuerySpecSchema, type QuerySpec } from "../types.js";
import { answerWorkflow, DEFAULT_CONFIRM_SHARE, type Answer } from "./answer.js";
import { COMPILE_ROLE, compileWorkflow } from "./compile.js";
import { DEFAULT_MODELS, stageRoutes, type Models, type RunnerFor } from "./routes.js";
import { AnswerSchema, CompileRecordSchema, ModelsSchema } from "./records.js";
import { readContent, readJson, runPaths, storeContent, writeJson } from "./run-dir.js";

export const COMPILE_WORKFLOW = "cq-compile";
export const ANSWER_WORKFLOW = "cq-answer";

export interface HostOptions {
  /** Per-user data dir: run state, content-addressed specs and rulings, run artifacts. */
  dataDir: string;
  /** The model runner seam; tests pass fakes, production uses `agentRunner`. */
  runnerFor?: RunnerFor;
  /** A dead process holds its run this long before `resume` may claim it. */
  leaseMs?: number;
  onEvent?: (event: WorkflowEvent) => void;
  /** Stops driving the run as a crash would, but releases its lease at once, so `resume` can claim it straight away. */
  signal?: AbortSignal;
}

export interface AskOptions {
  question: string;
  corpus: string;
  index: string;
  rules?: string;
  /** Skips the compile run. */
  spec?: QuerySpec;
  models?: Partial<Models>;
  rounds?: number;
  concurrency?: number;
  budgetUsd?: number;
  /** Fraction of the budget screening may not spend, kept for confirm. */
  confirmShare?: number;
  batchTokens?: number;
  window?: number;
}

export interface AskResult {
  compileRunId?: string;
  runId: string;
  status: string;
  answer?: Answer;
}

/** Long enough that a slow synchronous batch build never loses the run; Ctrl-C releases it at once anyway. */
const DEFAULT_LEASE_MS = 120_000;

function openState(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(path.join(dataDir, "state.sqlite3"));
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

function newRuntime(db: Db, runner: StepRunner, host: HostOptions): WorkflowRuntime {
  return new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, leaseMs: host.leaseMs ?? DEFAULT_LEASE_MS, ...(host.onEvent ? { onEvent: host.onEvent } : {}) });
}

async function compileSpec(db: Db, host: HostOptions, question: string, rulesSha: string | undefined, model: string): Promise<{ runId: string; spec: QuerySpec }> {
  const runtime = newRuntime(db, stageRoutes([{ stage: "compile", model, systemPrompt: COMPILE_ROLE }], host.runnerFor), host);
  runtime.register(COMPILE_WORKFLOW, compileWorkflow({ dataDir: host.dataDir, model }));
  const run = await runtime.wait(runtime.start(COMPILE_WORKFLOW, { question, ...(rulesSha ? { rulesSha } : {}) }));
  if (run.status !== "completed") throw new Error(`compile run ${run.id} ${run.status}: ${run.error ?? "no error recorded"}`);
  const record = readJson(runPaths(host.dataDir, run.id).compile, CompileRecordSchema);
  if (!record) throw new Error(`compile run ${run.id} completed without its record`);
  return { runId: run.id, spec: record.spec };
}

/** Everything a `cq-answer` run needs is in its params, so `resume` rebuilds the same prefixes and runner. */
function answerParams(options: AskOptions, specSha: string, rulesSha: string | undefined, compileRunId: string | undefined): Record<string, string> {
  return {
    ...(compileRunId ? { compileRunId } : {}),
    question: options.question,
    corpus: path.resolve(options.corpus),
    index: path.resolve(options.index),
    specSha,
    ...(rulesSha ? { rulesSha } : {}),
    models: JSON.stringify({ ...DEFAULT_MODELS, ...options.models }),
    rounds: String(options.rounds ?? 2),
    concurrency: String(options.concurrency ?? 4),
    budgetUsd: String(options.budgetUsd ?? 3),
    confirmShare: String(options.confirmShare ?? DEFAULT_CONFIRM_SHARE),
    batchTokens: String(options.batchTokens ?? 6000),
    window: String(options.window ?? 2),
  };
}

interface AnswerHost {
  runtime: WorkflowRuntime;
  close: () => void;
}

function answerHost(db: Db, host: HostOptions, params: Record<string, string>): AnswerHost {
  const spec = QuerySpecSchema.parse(JSON.parse(readContent(host.dataDir, "specs", params.specSha!)));
  const rules = params.rulesSha === undefined ? undefined : readContent(host.dataDir, "rules", params.rulesSha);
  const models = ModelsSchema.parse(JSON.parse(params.models ?? ""));
  const prefix = (role: string) => buildJudgePrefix({ role, question: params.question!, spec, ...(rules === undefined ? {} : { rules }) });
  const prefixes = { screen: prefix(SCREEN_ROLE), confirm: prefix(CONFIRM_ROLE) };
  const routes = stageRoutes([{ stage: "screen", model: models.screen, systemPrompt: prefixes.screen }, { stage: "confirm", model: models.confirm, systemPrompt: prefixes.confirm }], host.runnerFor);
  const index = openDatabase(params.index!, { readonly: true });
  const runtime = newRuntime(db, routes, host);
  const numeric = (key: string) => Number(params[key]);
  runtime.register(ANSWER_WORKFLOW, answerWorkflow({
    db: index, root: params.corpus!, dataDir: host.dataDir, spec, prefixes, models,
    ...(params.compileRunId ? { compileRunId: params.compileRunId } : {}),
    rounds: numeric("rounds"), concurrency: numeric("concurrency"), budgetUsd: numeric("budgetUsd"), batchTokens: numeric("batchTokens"), window: numeric("window"),
    confirmShare: params.confirmShare === undefined ? DEFAULT_CONFIRM_SHARE : numeric("confirmShare"),
  }));
  return { runtime, close: () => index.close() };
}

async function settle(app: AnswerHost, host: HostOptions, runId: string): Promise<AskResult> {
  const stop = () => app.runtime.shutdown();
  host.signal?.addEventListener("abort", stop, { once: true });
  try {
    if (host.signal?.aborted) stop();
    const run = await app.runtime.wait(runId);
    const answer = run.status === "completed" ? readJson(runPaths(host.dataDir, runId).answer, AnswerSchema) : undefined;
    return { runId, status: run.status, ...(answer ? { answer } : {}) };
  } finally {
    host.signal?.removeEventListener("abort", stop);
    app.close();
  }
}

/** Compile (unless a spec is given), then answer: two runs, because the answer run's prefix is built from the spec. */
export async function ask(options: AskOptions, host: HostOptions): Promise<AskResult> {
  const db = openState(host.dataDir);
  try {
    const rulesSha = options.rules === undefined ? undefined : storeContent(host.dataDir, "rules", options.rules);
    const compiled = options.spec ? undefined : await compileSpec(db, host, options.question, rulesSha, options.models?.compile ?? DEFAULT_MODELS.compile);
    const spec = options.spec ?? compiled!.spec;
    const specSha = storeContent(host.dataDir, "specs", `${JSON.stringify(spec, null, 2)}\n`);
    const params = answerParams(options, specSha, rulesSha, compiled?.runId);
    const app = answerHost(db, host, params);
    const runId = app.runtime.start(ANSWER_WORKFLOW, params, { onStart: (id) => writeJson(runPaths(host.dataDir, id).spec, spec) });
    return { ...(compiled ? { compileRunId: compiled.runId } : {}), ...(await settle(app, host, runId)) };
  } finally {
    db.close();
  }
}

/** Claims a crashed `cq-answer` run once its lease lapses and drives it on; finished batches replay from the record. */
export async function resume(runId: string, host: HostOptions): Promise<AskResult> {
  const db = openState(host.dataDir);
  try {
    const run = new WorkflowRunStore(db).get(runId);
    if (!run || run.workflowName !== ANSWER_WORKFLOW) throw new Error(`no ${ANSWER_WORKFLOW} run ${runId}`);
    const app = answerHost(db, host, run.params);
    const others = new Set(app.runtime.list().map((r) => r.id).filter((id) => id !== runId));
    const claimed = await app.runtime.hydrate({ exclude: others });
    if (!claimed.includes(runId)) {
      app.close();
      const status = app.runtime.status(runId)?.status;
      if (status === "completed" || status === "failed" || status === "cancelled") return { runId, status };
      throw new Error(`run ${runId} is still leased by another process; retry after ${(host.leaseMs ?? DEFAULT_LEASE_MS) / 1000}s`);
    }
    return await settle(app, host, runId);
  } finally {
    db.close();
  }
}
