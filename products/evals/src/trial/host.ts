import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { routedRunner, workflowMigration, workflowOwnershipMigration, WorkflowRuntime, type StepRunner, type WorkflowFn, type WorkflowRun } from "@titan-design/workflow";
import type { TrialRecord, VariantSpec } from "../spec/index.js";
import { emptyCost, finalOutput, outcomeOf, type TrialObservations, type TrialRunRecord } from "./record.js";
import { manifestRoutes, type CodeStep, type TrialLaunch } from "./routes.js";

/** What a variant's `topology` export resolves to. */
export interface TrialTopology {
  /** Every step id `run` dispatches, so a step the manifest does not route is refused before the run starts. */
  steps: readonly string[];
  run: WorkflowFn;
  code?: Readonly<Record<string, CodeStep>>;
}

export interface TrialHostOptions {
  variant: VariantSpec;
  topology: TrialTopology;
  /** The trial's own SQLite file; `:memory:` for a run that need not survive a crash. */
  dbPath: string;
  launch?: TrialLaunch;
  now?: () => number;
  leaseMs?: number;
}

export interface TrialStartInput {
  trialId: string;
  identity: TrialRecord;
  /** The case's inputs, read by the topology through `ctx.param`. */
  params?: Record<string, string>;
}

export interface TrialHost {
  readonly runtime: WorkflowRuntime;
  /** Runs the trial once to a settled record; a host runs one trial. */
  run(trial: TrialStartInput): Promise<TrialRunRecord>;
  /**
   * Settles the run already in the trial's file, or starts one when the file has none. Only attempts made by this host
   * are recorded: steps that finished before the crash replay from the file without a dispatch.
   */
  resume(trial: TrialStartInput): Promise<TrialRunRecord>;
  close(): void;
}

/** One workflow runtime over one trial's SQLite file, with routes built from the variant's steps. */
export function createTrialHost(options: TrialHostOptions): TrialHost {
  const { variant, topology } = options;
  const now = options.now ?? Date.now;
  const observations: TrialObservations = { attempts: [], calls: [], cost: emptyCost() };
  const runner = routedRunner(manifestRoutes(variant, { code: topology.code ?? {}, launch: options.launch, observations, now }));
  runner.assertRoutes(variant.id, topology.steps);
  const { db, runtime } = openRuntime(options, runner, now);

  let started = false;
  const claim = (): void => {
    if (started) throw new Error(`trial host for ${variant.id} already ran a trial; open one host per trial`);
    started = true;
  };
  const settle = (trial: TrialStartInput, runId: string) => settledRecord(runtime, observations, trial, runId);
  return {
    runtime,
    async run(trial) {
      claim();
      return settle(trial, runtime.start(variant.id, trial.params ?? {}));
    },
    async resume(trial) {
      claim();
      const runId = await resumableRun(runtime, variant.id);
      return settle(trial, runId ?? runtime.start(variant.id, trial.params ?? {}));
    },
    close() {
      runtime.shutdown();
      db.close();
    },
  };
}

async function settledRecord(runtime: WorkflowRuntime, observations: TrialObservations, trial: TrialStartInput, runId: string): Promise<TrialRunRecord> {
  const run = await runtime.wait(runId);
  return {
    trialId: trial.trialId,
    identity: trial.identity,
    ...observations,
    outcome: outcomeOf(run.status, observations.attempts),
    output: finalOutput(run),
    ...(run.error ? { error: run.error } : {}),
  };
}

const ALL_STATUSES: readonly WorkflowRun["status"][] = ["running", "paused", "cancelling", "recovery_required", "completed", "failed", "cancelled"];
const HELD_STATUSES: ReadonlySet<WorkflowRun["status"]> = new Set(["running", "paused", "cancelling"]);

/** The trial file's one run, hydrated so its finished steps replay from the file and its active ones follow `onRestart`. */
async function resumableRun(runtime: WorkflowRuntime, variantId: string): Promise<string | undefined> {
  const [hydrated] = await runtime.hydrate();
  if (hydrated) return hydrated;
  const [run] = runtime.list(ALL_STATUSES);
  if (run && HELD_STATUSES.has(run.status)) throw new Error(`trial run ${run.id} of ${variantId} is still leased by another runtime; resume it after the lease expires`);
  return run?.id;
}

function openRuntime(options: TrialHostOptions, runner: StepRunner, now: () => number): { db: Db; runtime: WorkflowRuntime } {
  if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
  const db = openDatabase(options.dbPath);
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  const runtime = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, now, leaseMs: options.leaseMs });
  runtime.register(options.variant.id, options.topology.run);
  return { db, runtime };
}
