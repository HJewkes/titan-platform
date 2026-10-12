import { hasColumn, openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import {
  WorkflowOwnershipLostError,
  WorkflowRunStore,
  WorkflowStoreSchemaOutdated,
  newRun,
  workflowDefinitionVersionMigration,
  workflowMigration,
  workflowOwnershipMigration,
} from "./store.js";

const PRE_VERSION_DDL = `CREATE TABLE workflow_run (
  id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL,
  current_step TEXT, step_results TEXT NOT NULL DEFAULT '{}', active_steps TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL, completed_at TEXT, error TEXT, revision INTEGER NOT NULL DEFAULT 0,
  owner_generation INTEGER NOT NULL DEFAULT 0, owner_runtime_id TEXT, owner_lease_until TEXT
)`;

describe("WorkflowRunStore definition version", () => {
  it("adds the definition_version column to an existing table, and a second run is a no-op", () => {
    const db = openDatabase(":memory:");
    db.exec(PRE_VERSION_DDL);
    const migration = workflowDefinitionVersionMigration(1);

    migration.up(db);
    migration.up(db);

    expect(hasColumn(db, "workflow_run", "definition_version")).toBe(true);
    const store = new WorkflowRunStore(db);
    store.create(newRun("run-1", "demo", {}, "v1"));
    expect(store.get("run-1")?.definitionVersion).toBe("v1");
  });

  it("round-trips an unpinned run without the column and refuses a pinned one", () => {
    const db = openDatabase(":memory:");
    db.exec(PRE_VERSION_DDL);
    const store = new WorkflowRunStore(db);

    store.create(newRun("unpinned", "demo", {}));

    expect(store.get("unpinned")).toMatchObject({ id: "unpinned", status: "running" });
    expect(store.get("unpinned")?.definitionVersion).toBeUndefined();
    expect(() => store.create(newRun("pinned", "demo", {}, "v1"))).toThrow(WorkflowStoreSchemaOutdated);
    expect(store.get("pinned")).toBeUndefined();
  });
});

describe("WorkflowRunStore ownership", () => {
  it("upgrades an existing table without requiring it to be recreated", () => {
    const db = openDatabase(":memory:");
    db.exec(`CREATE TABLE workflow_run (
      id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, params TEXT NOT NULL, status TEXT NOT NULL,
      current_step TEXT, step_results TEXT NOT NULL DEFAULT '{}', active_steps TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL, completed_at TEXT, error TEXT
    )`);

    runMigrations(db, [workflowOwnershipMigration(1)]);

    for (const column of ["revision", "owner_generation", "owner_runtime_id", "owner_lease_until"]) {
      expect(hasColumn(db, "workflow_run", column)).toBe(true);
    }
  });

  it("accepts only the current revision and owner generation after lease takeover", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [workflowMigration(1), workflowOwnershipMigration(2)]);
    const store = new WorkflowRunStore(db);
    const initial = newRun("run-1", "demo", {});
    store.create(initial);
    const first = store.claim("run-1", "runtime-a", iso(100), iso(0))!;
    expect(first).toMatchObject({ revision: 1, ownerGeneration: 1, owner: { runtimeId: "runtime-a", generation: 1 } });
    expect(store.claim("run-1", "runtime-b", iso(200), iso(50))).toBeUndefined();

    first.currentStep = "one";
    store.save(first, { runtimeId: "runtime-a", generation: 1 }, iso(150), iso(25));
    expect(first.revision).toBe(2);
    const second = store.claim("run-1", "runtime-b", iso(300), iso(151))!;
    expect(second).toMatchObject({ revision: 3, ownerGeneration: 2, owner: { runtimeId: "runtime-b", generation: 2 } });

    first.currentStep = "stale";
    expect(() => store.save(first, { runtimeId: "runtime-a", generation: 1 }, iso(400), iso(152))).toThrow(WorkflowOwnershipLostError);
    second.currentStep = "current";
    store.save(second, { runtimeId: "runtime-b", generation: 2 }, iso(400), iso(152));
    expect(store.get("run-1")?.currentStep).toBe("current");
  });

  it("loads active steps written by earlier versions as legacy attempts", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [workflowMigration(1)]);
    const store = new WorkflowRunStore(db);
    store.create(newRun("run-old", "demo", {}));
    db.prepare("UPDATE workflow_run SET active_steps = ? WHERE id = ?").run(
      JSON.stringify({ plan: { stepId: "plan", iterKey: "plan:0", startedAt: iso(0), runnerRef: "old-ref" } }),
      "run-old",
    );

    expect(store.get("run-old")?.activeSteps.plan).toEqual({
      kind: "legacy",
      stepId: "plan",
      iterKey: "plan:0",
      attempt: 0,
      startedAt: iso(0),
      runnerRef: "old-ref",
    });
  });

  it("normalizes lease timestamps and rejects invalid or expired leases", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [workflowMigration(1)]);
    const store = new WorkflowRunStore(db);
    store.create(newRun("run-time", "demo", {}));

    expect(() => store.claim("run-time", "runtime", "not-a-date", iso(0))).toThrow(/valid timestamp/);
    expect(() => store.claim("run-time", "runtime", iso(0), iso(0))).toThrow(/later than/);
    const run = store.claim("run-time", "runtime", "1970-01-01T00:00:01Z", "1970-01-01T00:00:00Z")!;
    expect(run.owner?.leaseUntil).toBe("1970-01-01T00:00:01.000Z");
    expect(() => store.renew(run, { runtimeId: "runtime", generation: 1 }, iso(1), iso(2))).toThrow(/later than/);
  });

  it("does not claim a terminal workflow row", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [workflowMigration(1)]);
    const store = new WorkflowRunStore(db);
    store.create(newRun("run-terminal", "demo", {}));
    db.prepare("UPDATE workflow_run SET status = 'completed', completed_at = ? WHERE id = ?").run(iso(1), "run-terminal");

    expect(store.claim("run-terminal", "runtime", iso(10), iso(2))).toBeUndefined();
  });
});

describe("WorkflowRunStore countByStatus", () => {
  it("counts each asked status, zero when no run has it, and leaves other statuses out", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, [workflowMigration(1)]);
    const store = new WorkflowRunStore(db);
    for (const id of ["a", "b", "c", "d"]) store.create(newRun(id, "demo", {}));
    db.prepare("UPDATE workflow_run SET status = 'completed' WHERE id IN ('c', 'd')").run();
    db.prepare("UPDATE workflow_run SET status = 'paused' WHERE id = 'b'").run();

    const counts = store.countByStatus(["running", "completed", "failed"]);

    expect(Object.fromEntries(counts)).toEqual({ running: 1, completed: 2, failed: 0 });
    expect(counts.get("running")).toBe(store.listByStatus(["running"]).length);
  });
});

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

describe("WorkflowRunStore annotate", () => {
  const fact = (data: Record<string, unknown>) => ({ stepId: "later", iteration: 0, agentId: null, signal: null, completedAt: iso(0), data });

  function storeWith(status: "running" | "completed"): WorkflowRunStore {
    const db = openDatabase(":memory:");
    runMigrations(db, [workflowMigration(1), workflowOwnershipMigration(2)]);
    const store = new WorkflowRunStore(db);
    store.create({ ...newRun("run-1", "demo", {}), status });
    return store;
  }

  it("adds a later fact to a finished run once, and never rewrites it", () => {
    const store = storeWith("completed");

    expect(store.annotate("run-1", "later", fact({ n: 1 }))).toBe(true);
    expect(store.annotate("run-1", "later", fact({ n: 2 }))).toBe(false);

    expect(store.get("run-1")!.stepResults.later?.data).toEqual({ n: 1 });
  });

  it("leaves a run that has not finished alone", () => {
    const store = storeWith("running");

    expect(store.annotate("run-1", "later", fact({ n: 1 }))).toBe(false);
    expect(store.get("run-1")!.stepResults).toEqual({});
  });
});

describe("WorkflowRunStore narrow reads", () => {
  function storeOf(runs: { id: string; status: string; completedAt?: string }[]): WorkflowRunStore {
    const db = openDatabase(":memory:");
    runMigrations(db, [workflowMigration(1)]);
    const store = new WorkflowRunStore(db);
    for (const { id, status, completedAt } of runs) {
      store.create(newRun(id, "demo", {}));
      db.prepare("UPDATE workflow_run SET status = ?, completed_at = ? WHERE id = ?").run(status, completedAt ?? null, id);
    }
    return store;
  }

  it("reports every run's status by id", () => {
    const store = storeOf([{ id: "a", status: "running" }, { id: "b", status: "completed", completedAt: "2026-10-01T00:00:00.000Z" }]);

    expect(Object.fromEntries(store.statuses())).toEqual({ a: "running", b: "completed" });
  });

  it("pages the asked statuses in id order from after the last id, finished no earlier than the cutoff", () => {
    const store = storeOf([
      { id: "d", status: "completed", completedAt: "2026-10-05T00:00:00.000Z" },
      { id: "a", status: "completed", completedAt: "2026-10-04T00:00:00.000Z" },
      { id: "c", status: "running" },
      { id: "b", status: "completed", completedAt: "2026-10-01T00:00:00.000Z" },
      { id: "e", status: "completed", completedAt: "2026-10-06T00:00:00.000Z" },
    ]);
    const options = { limit: 2, completedSince: "2026-10-02T00:00:00.000Z" };

    const first = store.page(["completed"], options);
    const second = store.page(["completed"], { ...options, after: first.at(-1)!.id });

    expect(first.map((run) => run.id)).toEqual(["a", "d"]);
    expect(second.map((run) => run.id)).toEqual(["e"]);
    expect(store.page(["completed", "running"], { limit: 10 }).map((run) => run.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
});
