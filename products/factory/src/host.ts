import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GateRecord } from "@titan-design/hitl";
import { FACTORY_ANSWER_ALLOWANCES } from "./coordinator-allowances.js";
import { coordinatorEvidencePolicy } from "./coordinator-evidence.js";
import { deviceGateAuthorize } from "./device-gates.js";
import { GateBatchStore, gateBatchMigration } from "./gate-batch-store.js";
import { SqliteGateStore, gateBriefMigration, gateEvidenceMigration, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db, type Migration } from "@titan-design/store-sqlite";
import {
  routedRunner,
  type StepRoute,
  type WorkflowEvent,
  workflowMigration,
  workflowOwnershipMigration,
  type WorkflowRun,
  WorkflowRuntime,
} from "@titan-design/workflow";
import type { ShepherdServices } from "./shepherd/commands.js";
import { assertDistinctStepIds, dispatchStepIds, guardedContext, type WorkflowDefinition } from "./definition.js";

/** State a route set keeps in the factory database: the host runs its migrations after its own and binds it while open. */
export interface DatabaseTenant {
  extraMigrations: readonly Migration[];
  /** Returns the unbind, called before the database closes. */
  bind(db: Db): () => void;
}

/** Routes travel with the tenant they read, so every caller that passes the routes also opens their tables. */
export type FactoryRoutes = readonly StepRoute[] & {
  readonly database?: DatabaseTenant;
  readonly shepherd?: ShepherdServices;
  /** Hands routes that start or read other runs the host they run on; returns the unbind, called on close. */
  readonly bindHost?: (host: FactoryHost) => () => void;
};

export interface FactoryHostOptions {
  dbPath: string;
  workflows: readonly WorkflowDefinition[];
  routes: FactoryRoutes;
  now?: () => number;
  leaseMs?: number;
  gatePollMs?: number;
  runtimeId?: string;
  onEvent?: (event: WorkflowEvent) => void;
}

export interface PendingGate {
  runId: string;
  stepId: string;
  gate: GateRecord;
}

/** A run `resume` could not drive: parked for a human, or still leased by a process that may be alive. */
export interface HeldRun {
  run: WorkflowRun;
  reason: "recovery_required" | "leased";
}

export interface ResumeReport {
  resumed: WorkflowRun[];
  held: HeldRun[];
  gates: PendingGate[];
}

export interface FactoryHost {
  readonly runtime: WorkflowRuntime;
  readonly gates: SqliteGateStore;
  /** Signed batches of merge-gate resolves (`gate resolve-batch`). */
  readonly batches: GateBatchStore;
  /** Hydrate every unfinished run, drive each until it ends or waits on a human, then release them. */
  resume(): Promise<ResumeReport>;
  /** Claim every unfinished run whose lease is free and keep driving it; the ids it claimed, never those in `exclude`. Leases stay held until `close()`. */
  adopt(options?: { exclude?: ReadonlySet<string> }): Promise<string[]>;
  pendingGates(): PendingGate[];
  close(): void;
}

const SETTLED: ReadonlySet<WorkflowRun["status"]> = new Set(["completed", "failed", "cancelled", "recovery_required"]);

/** One SQLite file holds runs, gates and the routes' tenant; 1-3 match the codewatch triage host, 7 follows the shepherd tenant's 4-6, 13 to 15 follow the tenant's 12, and the tenant's 16 follows them. */
export function openFactoryHost(options: FactoryHostOptions): FactoryHost {
  if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
  const db = openDatabase(options.dbPath);
  const tenant = options.routes.database;
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(7), gateBriefMigration(13), gateEvidenceMigration(14), gateBatchMigration(15), ...(tenant?.extraMigrations ?? [])]);
  const gates = new SqliteGateStore(db, { migrate: false, requireBrief: true, allowances: FACTORY_ANSWER_ALLOWANCES, evidencePolicy: coordinatorEvidencePolicy, authorize: deviceGateAuthorize });
  const runtime = createRuntime(db, gates, options);
  const unbind = tenant?.bind(db);
  const pendingGates = (): PendingGate[] => listPendingGates(runtime, gates);
  const host: FactoryHost = {
    runtime,
    gates,
    batches: new GateBatchStore(db, options.now),
    pendingGates,
    resume: () => resume(runtime, pendingGates, options.gatePollMs ?? 250, options.now ?? Date.now),
    adopt: (adoptOptions) => runtime.hydrate(adoptOptions),
    close: () => {
      runtime.shutdown();
      unbindHost?.();
      unbind?.();
      db.close();
    },
  };
  const unbindHost = options.routes.bindHost?.(host);
  return host;
}

function createRuntime(db: Db, gates: SqliteGateStore, options: FactoryHostOptions): WorkflowRuntime {
  const runner = routedRunner(options.routes);
  const runtime = new WorkflowRuntime({
    db,
    gates,
    runner,
    now: options.now,
    leaseMs: options.leaseMs,
    gatePollMs: options.gatePollMs,
    runtimeId: options.runtimeId,
    onEvent: options.onEvent,
  });
  for (const definition of options.workflows) {
    assertDistinctStepIds(definition);
    runner.assertRoutes(definition.name, dispatchStepIds(definition));
    runtime.register(definition.name, (ctx) => definition.run(guardedContext(ctx, definition)));
  }
  return runtime;
}

async function resume(runtime: WorkflowRuntime, pendingGates: () => PendingGate[], pollMs: number, now: () => number): Promise<ResumeReport> {
  const resumedIds = await runtime.hydrate();
  await Promise.all(resumedIds.map((id) => untilSettledOrGated(runtime, pendingGates, id, pollMs)));
  const resumed = resumedIds.map((id) => runtime.status(id)).filter((run): run is WorkflowRun => run !== undefined);
  const report: ResumeReport = { resumed, held: heldRuns(runtime, new Set(resumedIds), now()), gates: pendingGates() };
  runtime.shutdown();
  return report;
}

export async function untilSettledOrGated(runtime: WorkflowRuntime, pendingGates: () => PendingGate[], runId: string, pollMs: number): Promise<void> {
  for (;;) {
    const run = runtime.status(runId);
    if (!run || SETTLED.has(run.status)) return;
    if (run.status === "paused" && pendingGates().some((pending) => pending.runId === runId)) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function heldRuns(runtime: WorkflowRuntime, resumed: ReadonlySet<string>, nowMs: number): HeldRun[] {
  return runtime.list().flatMap((run): HeldRun[] => {
    if (resumed.has(run.id)) return [];
    if (run.status === "recovery_required") return [{ run, reason: "recovery_required" }];
    if (run.owner && Date.parse(run.owner.leaseUntil) > nowMs) return [{ run, reason: "leased" }];
    return [];
  });
}

/** Gate ids are `<runId>/<stepId>` or `<runId>/<stepId>:<n>`; the run's current step names the waiting one. */
function listPendingGates(runtime: WorkflowRuntime, gates: SqliteGateStore): PendingGate[] {
  return gates.listPending().flatMap((gate) => {
    const slash = gate.id.indexOf("/");
    if (slash < 0) return [];
    const runId = gate.id.slice(0, slash);
    const run = runtime.status(runId);
    if (!run) return [];
    return [{ runId, stepId: run.currentStep ?? gate.id.slice(slash + 1), gate }];
  });
}
