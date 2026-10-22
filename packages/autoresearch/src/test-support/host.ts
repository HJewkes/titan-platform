import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { routedRunner, WorkflowRuntime, workflowMigration, workflowOwnershipMigration, type StepRoute } from "@titan-design/workflow";
import { arStepHandlers, type ArStepHandler } from "../handlers.js";
import { arStepId } from "../manifest.js";
import type { ArPorts } from "../ports.js";
import { AUTORESEARCH_WORKFLOW, runAutoresearch } from "../workflow.js";

export interface TestHost {
  runtime: WorkflowRuntime;
  /** Picks up the runs a closed host left in flight, as a restarted process would. */
  adopt(): Promise<string[]>;
  close(): void;
}

function route(handler: ArStepHandler): StepRoute {
  const run = async ({ prompt, signal }: { prompt: string; signal: AbortSignal }) => {
    try {
      return { ok: true as const, output: JSON.stringify({ result: await handler.run(JSON.parse(prompt), signal) }) };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error), retryable: false };
    }
  };
  return { match: arStepId(handler.name), onRestart: handler.onRestart, runner: { run } };
}

/** The smallest durable host for the recipe: one SQLite file, strict replay, and a plain route per port. */
export function openTestHost(ports: ArPorts, dbPath = ":memory:"): TestHost {
  const db = openDatabase(dbPath);
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  const runner = routedRunner(arStepHandlers(ports).map(route));
  const runtime = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, gatePollMs: 5 });
  runtime.register(AUTORESEARCH_WORKFLOW, runAutoresearch, { strictReplay: true });
  return { runtime, adopt: () => runtime.hydrate(), close: () => void (runtime.shutdown(), db.close()) };
}
