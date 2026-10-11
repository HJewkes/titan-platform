import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { WorkflowEvent, WorkflowFn } from "./types.js";

const OWNER = { class: "owner-terminal", id: "owner", channel: "test" } as const;

const gated: WorkflowFn = async (ctx) => {
  await ctx.dispatch("draft", "draft");
  await ctx.assisted("approve", "ok?");
};

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

function runtime(db: Db, events: WorkflowEvent[] = []): WorkflowRuntime {
  const gates = new SqliteGateStore(db, { migrate: false });
  return new WorkflowRuntime({ db, gates, runner: inlineRunner(() => "ok"), onEvent: (e) => events.push(e), gatePollMs: 10 });
}

async function pausedRun(db: Db, version?: string): Promise<string> {
  const first = runtime(db);
  first.register("wf", gated, version === undefined ? {} : { version });
  const runId = first.start("wf");
  await vi.waitFor(() => expect(first.status(runId)?.status).toBe("paused"));
  first.shutdown();
  return runId;
}

describe("workflow definition version pinning", () => {
  it("parks a run started under version 1 when version 2 is registered, and never replays it", async () => {
    const db = makeDb();
    const runId = await pausedRun(db, "1");
    const fn = vi.fn(gated);
    const second = runtime(db);
    second.register("wf", fn, { version: "2" });

    expect(await second.hydrate()).toEqual([]);

    const parked = second.status(runId);
    expect(parked).toMatchObject({ status: "recovery_required", definitionVersion: "1" });
    expect(parked?.error).toBe('workflow wf definition changed: run pinned "1", registered "2"');
    expect(await second.hydrate()).toEqual([]);
    expect(second.status(runId)).toMatchObject({ status: "recovery_required", error: parked?.error });
    expect(fn).not.toHaveBeenCalled();
  });

  it("parks a pinned run when the definition is now registered with no version", async () => {
    const db = makeDb();
    const runId = await pausedRun(db, "1");
    const second = runtime(db);
    second.register("wf", gated);

    expect(await second.hydrate()).toEqual([]);
    expect(second.status(runId)?.error).toBe('workflow wf definition changed: run pinned "1", registered none');
  });

  it("resumes a run whose pinned version is still the registered one", async () => {
    const db = makeDb();
    const runId = await pausedRun(db, "1");
    const second = runtime(db);
    second.register("wf", gated, { version: "1" });

    expect(await second.hydrate()).toEqual([runId]);
    await vi.waitFor(() => expect(second.status(runId)?.currentStep).toBe("approve"));
    second.signal(runId, "approve", {}, OWNER);
    expect((await second.wait(runId)).status).toBe("completed");
  });

  it("resumes an unpinned run under any registered version", async () => {
    const db = makeDb();
    const runId = await pausedRun(db);
    const second = runtime(db);
    second.register("wf", gated, { version: "2" });

    expect(await second.hydrate()).toEqual([runId]);
    expect(second.status(runId)?.definitionVersion).toBeUndefined();
  });

  it("refuses an empty version at register", () => {
    expect(() => runtime(makeDb()).register("wf", gated, { version: "" })).toThrow(TypeError);
  });
});
