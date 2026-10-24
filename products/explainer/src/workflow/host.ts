import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { routedRunner, WorkflowRunStore, WorkflowRuntime, workflowMigration, workflowOwnershipMigration, type WorkflowEvent, type WorkflowRun } from "@titan-design/workflow";
import { createJudgeHarness, JudgeConfigSchema, type JudgeConfig } from "../eval-harness.js";
import type { L0Check } from "../eval-l0.js";
import { loadProfiles, profileFor } from "../profile-load.js";
import { MAX_REWRITE_ROUNDS } from "../rewrite-plan.js";
import type { StylePack } from "../style-pack-schema.js";
import { artifactMigration, ArtifactStore } from "./artifacts.js";
import { runBridgeFile, spawnExec, type BridgeExec, type BridgeFile } from "./bridge.js";
import type { HarnessFor, RunnerFor } from "./model-stages.js";
import { RunPlanSchema, stageRoute, VIDEO_WORKFLOW, VIDEO_WORKFLOW_VERSION, videoWorkflow, type RunPlan } from "./pipeline.js";
import { CACHED_STAGES, OPTIONAL_STAGES, RUN_INPUTS, type CachedStage, STAGES, StageRecordSchema, StopSchema, type StageName, type StageRecord } from "./records.js";
import { buildReport, ownUsd, renderReport, stageRecords, type LinkedRun, type RunReport } from "./report.js";
import { readJson, runPaths, writeJson, writeText } from "./run-dir.js";
import { BODY_STEP, CHECKS_STEP, childWorkflow, runStageCached, stageRunsMigration, type CacheDeps } from "./stage-cache.js";
import type { CheckJudge } from "./stage-checks.js";
import { STAGE_VERSIONS, stageSpec, VariantSchema } from "./stage-spec.js";
import { bodyRoute, checksRoute, stageWorkflow } from "./stage-workflows.js";
import type { TtsEngine } from "./tts-stage.js";
import type { GatherDeps, GatherRequest } from "./run-gather.js";

export interface RunHost {
  /** Run state, the artifact store, run directories and the bridge host file `bridge.json`. */
  dataDir: string;
  /** Where a bridge the run's profile names lives, as `bridges/<name>.json`; the data dir by default. */
  bridgeHome?: string;
  /** Model seams; tests pass fakes, production uses `agentRunner` and the judge harness. */
  runnerFor?: RunnerFor;
  harnessFor?: HarnessFor;
  /** The L0 checks the script, rewrite and eval stages run; all of them by default. */
  evalChecks?: readonly L0Check[];
  /** Runs the reported `listener-questions` check on the script stage, on the run's judge; off by default since it spends. */
  listener?: { threshold?: number };
  /** Runs a bridged command; tests pass a fake. */
  exec?: BridgeExec;
  /** The tts stage's engine; speech-tts Kokoro by default, tests pass a fake. */
  ttsEngine?: () => Promise<TtsEngine>;
  /** The style packs a render variant may pick; the shipped `doctrine/style-packs` by default. */
  stylePacks?: () => ReadonlyMap<string, StylePack>;
  /** The gather stage's outside world; tests pass a fake gh, task list, call graph and clone. */
  gather?: GatherDeps;
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
  /** The last stage to run; `export` (the theater) by default. */
  to?: StageName;
  /** The run whose records stand in for the stages before `from`; the latest run by default unless `pins` are given. */
  base?: string;
  /** Artifact name → sha in the store, laid over the base run's artifacts: how a run starts mid-pipeline. */
  pins?: Record<string, string>;
  /** Stage → a variant file (`explainer.variant/v1`), or `variantShas` for one already stored. */
  variants?: Partial<Record<StageName, string>>;
  variantShas?: Partial<Record<StageName, string>>;
  samples?: Partial<Record<StageName, number>>;
  /** The video this run belongs to; a run with a base belongs to the base run's video. */
  video?: string;
  budgetUsd?: number;
  scriptModel?: string;
  judge?: JudgeConfig;
  rounds?: number;
  /** The video type whose profile the audition reads; required from `audition`, and the gather's type by default. */
  profile?: string;
  /** What the gather stage gathers; required from `gather`. */
  gather?: GatherRequest;
  /** The folder export links into, in place of the bridge's `theater.dir`. */
  theater?: string;
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

export function openState(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(path.join(dataDir, "state.sqlite3"));
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4), artifactMigration(5), stageRunsMigration(6)]);
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
  const given = Object.entries(files).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return Object.fromEntries(given.map(([name, file]) => [name, store.putText(readFileSync(file, "utf8"), name, { runId: "input", stage: "input" })]));
}

function reusedFromBase(base: WorkflowRun, from: StageName): { reused: StageRecord[]; artifacts: Record<string, string> } {
  const records = stageRecords(base);
  const before = STAGES.slice(0, STAGES.indexOf(from));
  const reused = before.map((stage) => {
    const found = records.find((record) => record.stage === stage);
    if (!found && OPTIONAL_STAGES.includes(stage)) return undefined;
    if (!found) throw new Error(`base run ${base.id} has no completed ${stage} stage; start from ${stage} or earlier`);
    return found;
  }).filter((record) => record !== undefined);
  // A record the base itself reused already has its outputs in the base plan, under any pin; folding it again would undo the pin.
  const ran = reused.filter((record) => !record.reusedFrom);
  const artifacts = ran.reduce<Record<string, string>>((acc, record) => ({ ...acc, ...record.outputs }), { ...planOf(base).artifacts });
  return { reused, artifacts };
}

/** Each variant file is stored as an artifact, so the plan (and the stage key) holds its sha, not a path. */
function storeVariants(request: RunRequest, store: ArtifactStore): RunPlan["variants"] {
  const stored: RunPlan["variants"] = { ...request.variantShas };
  for (const [stage, file] of Object.entries(request.variants ?? {})) {
    const variant = VariantSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    if (variant.stage !== stage) throw new Error(`variant file ${path.basename(file)} is for stage ${variant.stage}, not ${stage}`);
    stored[stage as StageName] = store.putText(readFileSync(file, "utf8"), "variant", { runId: "input", stage: "variant" });
  }
  return stored;
}

function checkPins(pins: Record<string, string>, store: ArtifactStore): Record<string, string> {
  for (const sha of Object.values(pins)) store.path(sha);
  return pins;
}

/** A run from `audition` or `script` starts from its input files; a later start needs a base run or pins. */
const startsFresh = (from: StageName): boolean => STAGES.indexOf(from) <= STAGES.indexOf("script");

/** True when the profile's audition writes the spine, so a run through the audition needs none given. */
const auditionWritesSpine = (profile: string | undefined): boolean =>
  profile !== undefined && profileFor(loadProfiles(), profile).spine?.from === "audition-pick";

/** The input files a run reads: facts for the audition, spine and facts once it reaches the script. */
function neededInputs(from: StageName, to: StageName, profile: string | undefined): string[] {
  const reachesScript = startsFresh(from) && STAGES.indexOf(to) >= STAGES.indexOf("script");
  const needed = new Set([...(from === "audition" ? ["facts"] : []), ...(reachesScript ? RUN_INPUTS : [])]);
  // A run from gather makes its own facts.
  if (from === "gather") needed.delete("facts");
  if (STAGES.indexOf(from) <= STAGES.indexOf("audition") && auditionWritesSpine(profile)) needed.delete("spine");
  return [...needed];
}

function buildPlan(request: RunRequest, db: Db, store: ArtifactStore): RunPlan {
  const from = request.from ?? "script";
  const to = request.to ?? "export";
  if (STAGES.indexOf(to) < STAGES.indexOf(from)) throw new Error(`--to ${to} comes before --from ${from}`);
  if (from === "gather" && !request.gather) throw new Error("a run from gather needs --facts-from <adapter>");
  const profile = request.profile ?? request.gather?.type;
  const settings = {
    budgetUsd: request.budgetUsd ?? DEFAULT_BUDGET_USD, scriptModel: request.scriptModel ?? DEFAULT_SCRIPT_MODEL,
    judge: request.judge ?? DEFAULT_JUDGE, rounds: request.rounds ?? MAX_REWRITE_ROUNDS,
    variants: storeVariants(request, store), samples: request.samples ?? {}, ...(profile ? { profile } : {}),
    ...(request.gather ? { gather: request.gather } : {}), ...(request.theater ? { theater: request.theater } : {}),
  };
  if (from === "audition" && !profile) throw new Error("a run from audition needs --profile <type>");
  const runs = new WorkflowRunStore(db);
  const pinned = request.pins !== undefined && Object.keys(request.pins).length > 0;
  const base = request.base || (!startsFresh(from) && !pinned) ? findBase(runs, request.base, from) : undefined;
  const fromBase = base ? reusedFromBase(base, from) : { reused: [], artifacts: {} };
  const artifacts = { ...fromBase.artifacts, ...inputArtifacts(request, store), ...checkPins(request.pins ?? {}, store) };
  const missing = neededInputs(from, to, profile).filter((name) => artifacts[name] === undefined);
  if (missing.length > 0) throw new Error(`this run needs ${missing.map((m) => `--${m}`).join(" and ")}`);
  const videoId = request.video ?? (base ? videoIdOf(runs, base) : undefined);
  return { from, to, ...(base ? { baseRunId: base.id } : {}), ...(videoId ? { videoId } : {}), artifacts, reused: fromBase.reused, ...settings };
}

/** A run's video: its plan's, else its base run's, else (the first run of a video) its own id. */
function videoIdOf(runs: WorkflowRunStore, run: WorkflowRun, seen = new Set<string>()): string {
  const plan = planOf(run);
  if (plan.videoId) return plan.videoId;
  const base = plan.baseRunId && !seen.has(plan.baseRunId) ? runs.get(plan.baseRunId) : undefined;
  return base ? videoIdOf(runs, base, seen.add(run.id)) : run.id;
}

function findBase(runs: WorkflowRunStore, id: string | undefined, from: StageName): WorkflowRun {
  const base = id ? runs.get(id) : latestRun(runs);
  if (base?.workflowName === VIDEO_WORKFLOW) return base;
  throw new Error(id ? `no ${VIDEO_WORKFLOW} run ${id}` : `no earlier ${VIDEO_WORKFLOW} run to start --from ${from} on; pass --base`);
}

const videoRuns = (runs: WorkflowRunStore): WorkflowRun[] =>
  runs.listByStatus(["running", "paused", "recovery_required", "completed", "failed", "cancelled"]).filter((run) => run.workflowName === VIDEO_WORKFLOW);

/** Every other run of the same video, oldest first: the video's cost is the sum over them (owner answer Q2 B). */
function linkedRuns(dataDir: string, runs: WorkflowRunStore, run: WorkflowRun): { videoId: string; linked: LinkedRun[] } {
  const videoId = videoIdOf(runs, run);
  const linked = videoRuns(runs)
    .filter((other) => other.id !== run.id && videoIdOf(runs, other) === videoId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((other) => ({ runId: other.id, usd: ownUsd(allRecords(dataDir, other)) }));
  return { videoId, linked };
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
    const { videoId, linked } = linkedRuns(host.dataDir, runs, run);
    const report = buildReport({ run, from: plan.from, to: plan.to, budgetUsd: plan.budgetUsd, records: stageRecords(run), ...(failed ? { failed } : {}), ...(stop ? { stop } : {}), videoId, linked });
    writeJson(paths.reportJson, report);
    writeText(paths.reportMd, renderReport(report));
    return { report, reportPath: paths.reportMd };
  } finally {
    db.close();
  }
}

function listenerJudge(host: RunHost, plan: RunPlan | undefined): { judge?: CheckJudge } {
  if (!host.listener) return {};
  const config = plan?.judge ?? DEFAULT_JUDGE;
  const threshold = host.listener.threshold === undefined ? {} : { listenerThreshold: host.listener.threshold };
  return { judge: { config, harness: (host.harnessFor ?? createJudgeHarness)(config), ...threshold } };
}

export interface Runtime {
  runtime: WorkflowRuntime;
  store: ArtifactStore;
  cache: CacheDeps;
  bridge: () => BridgeFile;
}

/** A runtime with one `explainer.<stage>` workflow per cached stage, and the parent `explainer-video` when a plan is given. */
export function newRuntime(db: Db, host: RunHost, plan?: RunPlan): Runtime {
  const store = new ArtifactStore(host.dataDir, db);
  let bridgeFile: BridgeFile | undefined;
  const bridge = () => (bridgeFile ??= runBridgeFile(host.dataDir, { home: host.bridgeHome, profile: plan?.profile, theater: plan?.theater }));
  const now = host.now ?? (() => new Date());
  const late: { runtime?: WorkflowRuntime } = {};
  const cache: CacheDeps = { db, dataDir: host.dataDir, now, runtime: () => late.runtime! };
  const body = bodyRoute({
    dataDir: host.dataDir, store, bridge, exec: host.exec ?? spawnExec, now,
    ...(host.runnerFor ? { runnerFor: host.runnerFor } : {}), ...(host.harnessFor ? { harnessFor: host.harnessFor } : {}), ...(host.evalChecks ? { evalChecks: host.evalChecks } : {}),
    ...(host.signal ? { signal: host.signal } : {}), ...(host.ttsEngine ? { ttsEngine: host.ttsEngine } : {}), ...(host.gather ? { gather: host.gather } : {}),
  });
  const checks = checksRoute({ dataDir: host.dataDir, store, now, ...(host.evalChecks ? { evalChecks: host.evalChecks } : {}), ...listenerJudge(host, plan) });
  const styles = host.stylePacks ? { stylePacks: host.stylePacks } : {};
  const routes = plan ? [body, checks, stageRoute({ dataDir: host.dataDir, store, plan, bridge, cache, now, ...styles })] : [body, checks];
  const runner = routedRunner(routes);
  for (const stage of CACHED_STAGES) runner.assertRoutes(childWorkflow(stage), [`${BODY_STEP}:${stage}`, `${CHECKS_STEP}:${stage}`]);
  if (plan) runner.assertRoutes(VIDEO_WORKFLOW, STAGES.map((stage) => `stage:${stage}`));
  const gates = new SqliteGateStore(db, { migrate: false });
  const runtime = new WorkflowRuntime({ db, gates, runner, leaseMs: host.leaseMs ?? DEFAULT_LEASE_MS, ...(host.onEvent ? { onEvent: host.onEvent } : {}) });
  late.runtime = runtime;
  for (const stage of CACHED_STAGES) runtime.register(childWorkflow(stage), stageWorkflow(), { version: STAGE_VERSIONS[stage] });
  if (plan) runtime.register(VIDEO_WORKFLOW, videoWorkflow(plan, host.dataDir), { version: VIDEO_WORKFLOW_VERSION });
  return { runtime, store, cache, bridge };
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
    const { runtime } = newRuntime(db, host, plan);
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
  const plan = planOf(run);
  const stage = STAGES.slice(STAGES.indexOf(plan.from), STAGES.indexOf(plan.to) + 1).find((s) => !done.has(s));
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
      const { runtime } = newRuntime(db, host, planOf(run));
      const claimed = await runtime.hydrate({ exclude: new Set(runtime.list().map((r) => r.id).filter((id) => id !== runId)) });
      if (!claimed.includes(runId)) throw new Error(`run ${runId} is still leased by another process; retry after ${(host.leaseMs ?? DEFAULT_LEASE_MS) / 1000}s`);
      return outcome(await settle(runtime, runId, host), host);
    }
  } finally {
    db.close();
  }
  const plan = planOf(run);
  return runVideo({
    from: resumeStage(host.dataDir, run), to: plan.to, base: runId, budgetUsd: overrides.budgetUsd ?? plan.budgetUsd, scriptModel: plan.scriptModel,
    judge: plan.judge, rounds: plan.rounds, variantShas: plan.variants, samples: plan.samples, ...(plan.profile ? { profile: plan.profile } : {}),
    ...(plan.gather ? { gather: plan.gather } : {}), ...(plan.theater ? { theater: plan.theater } : {}),
  }, host);
}

export interface StageRequest {
  stage: CachedStage;
  /** Artifact name → sha in the store: the inputs the stage reads. */
  inputs: Record<string, string>;
  /** A variant file for this stage. */
  variant?: string;
  sample?: number;
  budgetUsd?: number;
  scriptModel?: string;
  judge?: JudgeConfig;
  rounds?: number;
  profile?: string;
}

/** `explainer stage`: one stage as its own child run, through the stage cache, with no parent run. */
export async function runOneStage(request: StageRequest, host: RunHost): Promise<StageRecord> {
  const db = openState(host.dataDir);
  try {
    const rt = newRuntime(db, host);
    const variants = storeVariants({ ...(request.variant ? { variants: { [request.stage]: request.variant } } : {}) }, rt.store);
    const variantSha = variants[request.stage];
    const settings = {
      scriptModel: request.scriptModel ?? DEFAULT_SCRIPT_MODEL, judge: request.judge ?? DEFAULT_JUDGE, rounds: request.rounds ?? MAX_REWRITE_ROUNDS,
      ...(request.profile ? { profile: request.profile } : {}),
    };
    const spec = stageSpec({
      stage: request.stage, artifacts: checkPins(request.inputs, rt.store), settings, sample: request.sample ?? 0,
      remainingUsd: request.budgetUsd ?? DEFAULT_BUDGET_USD, bridge: rt.bridge, ...(host.stylePacks ? { stylePacks: host.stylePacks } : {}),
      ...(variantSha ? { variant: { sha: variantSha, value: VariantSchema.parse(JSON.parse(rt.store.readText(variantSha))) } } : {}),
    });
    return await runStageCached(rt.cache, spec);
  } finally {
    db.close();
  }
}
