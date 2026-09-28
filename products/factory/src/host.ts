import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GateRecord } from "@titan-design/hitl";
import { SqliteGateStore, gateMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import {
  WorkflowRuntime,
  workflowMigration,
  workflowOwnershipMigration,
  type WorkflowEvent,
  type WorkflowRun,
} from "@titan-design/workflow";
import { assertDistinctStepIds, guardedContext, type WorkflowDefinition } from "./definition.js";
import { routedRunner, type StepRoute } from "./routed-runner.js";

export interface FactoryHostOptions {
  dbPath: string;
  workflows: readonly WorkflowDefinition[];
  routes: readonly StepRoute[];
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
  /** Hydrate every unfinished run, drive each until it ends or waits on a human, then release them. */
  resume(): Promise<ResumeReport>;
  pendingGates(): PendingGate[];
  close(): void;
}

const SETTLED: ReadonlySet<WorkflowRun["status"]> = new Set(["completed", "failed", "cancelled", "recovery_required"]);

/** One SQLite file holds runs and gates; the three migrations match the codewatch triage host. */
export function openFactoryHost(options: FactoryHostOptions): FactoryHost {
  if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
  const db = openDatabase(options.dbPath);
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3)]);
  const gates = new SqliteGateStore(db, { migrate: false });
  const runtime = createRuntime(db, gates, options);
  const pendingGates = (): PendingGate[] => listPendingGates(runtime, gates);
  return {
    runtime,
    gates,
    pendingGates,
    resume: () => resume(runtime, pendingGates, options.gatePollMs ?? 250, options.now ?? Date.now),
    close: () => {
      runtime.shutdown();
      db.close();
    },
  };
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
    runner.assertRoutes(definition);
    runtime.register(definition.name, (ctx) => definition.run(guardedContext(ctx, definition)));
  }
  return runtime;
}

async function resume(runtime: WorkflowRuntime, pendingGates: () => PendingGate[], pollMs: number, now: () => number): Promise<ResumeReport> {
  const resumedIds = await runtime.hydrate();
  await Promise.all(resumedIds.map((id) => untilSettled(runtime, pendingGates, id, pollMs)));
  const resumed = resumedIds.map((id) => runtime.status(id)).filter((run): run is WorkflowRun => run !== undefined);
  const report: ResumeReport = { resumed, held: heldRuns(runtime, new Set(resumedIds), now()), gates: pendingGates() };
  runtime.shutdown();
  return report;
}

async function untilSettled(runtime: WorkflowRuntime, pendingGates: () => PendingGate[], runId: string, pollMs: number): Promise<void> {
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
