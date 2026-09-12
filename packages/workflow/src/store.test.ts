import { hasColumn, openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import {
  WorkflowOwnershipLostError,
  WorkflowRunStore,
  newRun,
  workflowMigration,
  workflowOwnershipMigration,
} from "./store.js";

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

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
