import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import {
  AuthorityDeniedError,
  AuthorityRefusedError,
  StepFailedError,
  WorkflowRecoveryRequiredError,
  WorkflowRuntime,
  inlineRunner,
  workflowMigration,
  workflowOwnershipMigration,
  type StepRunner,
  type WorkflowFn,
} from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { all } from "./all.js";

afterEach(() => vi.useRealTimers());

const red = (id: string) => new StepFailedError(id, 0, "red");
const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

function runtime(runner: StepRunner, db: Db = openDatabase(":memory:")): WorkflowRuntime {
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, gatePollMs: 10 });
}

describe("all", () => {
  it("a red child does not cancel its siblings: both siblings complete and the red one is reported", async () => {
    const finished: string[] = [];
    const sibling = (id: string, ms: number) => later(ms, id).then((v) => (finished.push(v), v));

    const out = await all([sibling("a", 5), Promise.reject(red("b")), sibling("c", 10)]);

    expect(finished).toEqual(["a", "c"]);
    expect(out.map((o) => (o.ok ? o.value : o.red.stepId))).toEqual(["a", "b", "c"]);
  });

  it("all adds no deadline: a child that resolves after a fake hour is awaited", async () => {
    vi.useFakeTimers();
    const pending = all([later(60 * 60 * 1000, "slow"), Promise.resolve("fast")]);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(await pending).toEqual([{ ok: true, value: "slow" }, { ok: true, value: "fast" }]);
  });

  it("a recovery-required child is rethrown only after the other children settle", async () => {
    let settled = false;
    const slow = later(10, "x").then(() => (settled = true));
    const parked = new WorkflowRecoveryRequiredError("run", "s", "evidence");

    const caught = await all([Promise.reject(parked), slow]).catch((e: unknown) => ({ e, settled }));

    expect(caught).toEqual({ e: parked, settled: true });
  });

  it.each([
    ["refused", new AuthorityRefusedError("merge", 0, "rule", "gate", "owner said no")],
    ["denied", new AuthorityDeniedError("merge", 0, "rule", "not allowed")],
  ])("an authority-%s child is rethrown, not reported red, after the other children settle", async (_, stop) => {
    let settled = false;
    const slow = later(10, "x").then(() => (settled = true));

    const caught = await all([Promise.reject(stop), slow]).catch((e: unknown) => ({ e, settled }));

    expect(caught).toEqual({ e: stop, settled: true });
  });

  it("a run whose children are all replayed from the record makes no live call", async () => {
    const live = vi.fn(() => "out");
    const db = openDatabase(":memory:");
    const recipe: WorkflowFn = async (ctx) => {
      await all([ctx.dispatch("a:1", "a"), ctx.dispatch("a:2", "b")]);
      await ctx.assisted("approve", "ok?");
    };
    const first = runtime(inlineRunner(live), db);
    first.register("fan", recipe, { strictReplay: true });
    const runId = first.start("fan");
    await vi.waitFor(() => expect(first.status(runId)?.status).toBe("paused"));
    first.shutdown();
    expect(live).toHaveBeenCalledTimes(2);

    const second = runtime(inlineRunner(live), db);
    second.register("fan", recipe, { strictReplay: true });
    expect(await second.hydrate()).toEqual([runId]);
    await vi.waitFor(() => expect(second.status(runId)?.currentStep).toBe("approve"));

    expect(live).toHaveBeenCalledTimes(2);
    expect(second.status(runId)?.status).toBe("paused");
  });
});
