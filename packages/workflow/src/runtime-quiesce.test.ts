import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { WorkflowRunStore, workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { WorkflowFn } from "./types.js";

const gated: WorkflowFn = async (ctx) => void (await ctx.assisted("approve", "ok?"));
const oneDispatch: WorkflowFn = async (ctx) => void (await ctx.dispatch("work", "work"));

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

function runtime(db: Db): WorkflowRuntime {
  const gates = new SqliteGateStore(db, { migrate: false });
  const rt = new WorkflowRuntime({ db, gates, runner: inlineRunner(() => "ok"), gatePollMs: 10 });
  rt.register("gated", gated);
  rt.register("one", oneDispatch);
  return rt;
}

function row(db: Db, runId: string) {
  return new WorkflowRunStore(db).get(runId);
}

describe("WorkflowRuntime.quiesce", () => {
  it("persists a run started after quiesce unclaimed, and the successor adopts it", async () => {
    const db = makeDb();
    const dying = runtime(db);
    dying.quiesce();

    const runId = dying.start("gated");

    expect(row(db, runId)?.status).toBe("running");
    expect(row(db, runId)?.owner).toBeUndefined();
    const successor = runtime(db);
    expect(await successor.hydrate()).toEqual([runId]);
    await vi.waitFor(() => expect(successor.status(runId)?.status).toBe("paused"));
    successor.shutdown();
  });

  it("commits onStart with the unclaimed row", () => {
    const db = makeDb();
    const dying = runtime(db);
    dying.quiesce();
    const started: string[] = [];

    const runId = dying.start("gated", {}, { onStart: (id) => started.push(id) });

    expect(started).toEqual([runId]);
  });

  it("claims nothing on hydrate once quiesced", async () => {
    const db = makeDb();
    const first = runtime(db);
    const runId = first.start("gated");
    await vi.waitFor(() => expect(first.status(runId)?.status).toBe("paused"));
    first.shutdown();
    const dying = runtime(db);
    dying.quiesce();

    expect(await dying.hydrate()).toEqual([]);
    expect(row(db, runId)?.owner).toBeUndefined();
  });

  it("releases the leases of live runs and reports quiesced", async () => {
    const db = makeDb();
    const rt = runtime(db);
    const runId = rt.start("gated");
    await vi.waitFor(() => expect(row(db, runId)?.status).toBe("paused"));
    expect(row(db, runId)?.owner).toBeDefined();
    expect(rt.quiesced()).toBe(false);

    rt.quiesce();

    expect(rt.quiesced()).toBe(true);
    expect(row(db, runId)?.owner).toBeUndefined();
  });

  it("marks a cancelled run cancelling and leaves it released for the successor", async () => {
    const db = makeDb();
    const dying = runtime(db);
    dying.quiesce();
    const runId = dying.start("one");

    dying.cancel(runId, "operator stop");

    expect(row(db, runId)).toMatchObject({ status: "cancelling", error: "operator stop" });
    expect(row(db, runId)?.owner).toBeUndefined();
    const successor = runtime(db);
    await successor.hydrate();
    expect((await successor.wait(runId)).status).toBe("cancelled");
  });
});
