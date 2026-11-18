import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { hasColumn, openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { codeRoute, codeStep } from "./code-step.js";
import { routedRunner, type StepRoute } from "./routed-runner.js";
import { WorkflowRuntime } from "./runtime.js";
import { WorkflowRunStore, workflowErrorClassMigration, workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { WorkflowFn } from "./types.js";

const PRE_CLASS_DDL = `CREATE TABLE workflow_run (
  id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL,
  current_step TEXT, step_results TEXT NOT NULL DEFAULT '{}', active_steps TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL, completed_at TEXT, error TEXT, revision INTEGER NOT NULL DEFAULT 0,
  owner_generation INTEGER NOT NULL DEFAULT 0, owner_runtime_id TEXT, owner_lease_until TEXT
)`;

class Classed extends Error {
  constructor(message: string, readonly errorClass: string) {
    super(message);
  }
}

const oneStep: WorkflowFn = async (ctx) => void (await codeStep(ctx, "read", {}, z.number()));

function runtime(db: Db, route: StepRoute): WorkflowRuntime {
  const rt = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner: routedRunner([route]), gatePollMs: 10 });
  rt.register("one", oneStep);
  return rt;
}

function freshDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

const classOf = (error: unknown) => (error instanceof Classed ? error.errorClass : undefined);
const throwing = (error: Error) => codeRoute("read", async () => { throw error; }, { errorClass: classOf });

describe("a failed run's error class", () => {
  it("is stored from the class the failing step's error carried", async () => {
    const db = freshDb();
    const rt = runtime(db, throwing(new Classed("waited too long", "slow")));

    const run = await rt.wait(rt.start("one"));

    expect(run.status).toBe("failed");
    expect(new WorkflowRunStore(db).get(run.id)?.errorClass).toBe("slow");
  });

  it("is absent when the step's error carried none", async () => {
    const db = freshDb();
    const rt = runtime(db, throwing(new Error("plain")));

    const run = await rt.wait(rt.start("one"));

    expect(run.status).toBe("failed");
    expect(new WorkflowRunStore(db).get(run.id)).not.toHaveProperty("errorClass");
  });

  it("is added to an older table by a migration that is safe to run twice", () => {
    const db = openDatabase(":memory:");
    db.exec(PRE_CLASS_DDL);
    const migration = workflowErrorClassMigration(1);

    migration.up(db);
    migration.up(db);

    expect(hasColumn(db, "workflow_run", "error_class")).toBe(true);
  });

  it("is dropped, not refused, by a table that predates the column", async () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [gateMigration(1), gateResolverMigration(4)]);
    db.exec(PRE_CLASS_DDL);
    const rt = runtime(db, throwing(new Classed("waited too long", "slow")));

    const run = await rt.wait(rt.start("one"));

    expect(run.status).toBe("failed");
    expect(new WorkflowRunStore(db).get(run.id)?.error).toContain("waited too long");
  });
});
