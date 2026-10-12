import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { routedRunner, workflowMigration, workflowOwnershipMigration, WorkflowRuntime, type StepRunner, type WorkflowFn } from "@titan-design/workflow";
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
  return {
    runtime,
    async run(trial) {
      if (started) throw new Error(`trial host for ${variant.id} already ran a trial; open one host per trial`);
      started = true;
      const run = await runtime.wait(runtime.start(variant.id, trial.params ?? {}));
      return {
        trialId: trial.trialId,
        identity: trial.identity,
        ...observations,
        outcome: outcomeOf(run.status, observations.attempts),
        output: finalOutput(run),
        ...(run.error ? { error: run.error } : {}),
      };
    },
    close() {
      runtime.shutdown();
      db.close();
    },
  };
}

function openRuntime(options: TrialHostOptions, runner: StepRunner, now: () => number): { db: Db; runtime: WorkflowRuntime } {
  if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
  const db = openDatabase(options.dbPath);
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  const runtime = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, now, leaseMs: options.leaseMs });
  runtime.register(options.variant.id, options.topology.run);
  return { db, runtime };
}
