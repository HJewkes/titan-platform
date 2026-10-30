import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CodeStepFailure, codeRecordRoute, codeRoute, codeStep } from "./code-step.js";
import { routedRunner, type StepRoute } from "./routed-runner.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { WorkflowFn, WorkflowRun } from "./types.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

function runtime(db: Db, routes: StepRoute[]): WorkflowRuntime {
  const rt = new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner: routedRunner(routes), gatePollMs: 10 });
  rt.register("count", countThenEcho);
  return rt;
}

function recorded(run: WorkflowRun, key: string): unknown {
  return JSON.parse(run.stepResults[key]?.output ?? "null");
}

const Count = z.object({ count: z.number() });

const countThenEcho: WorkflowFn = async (ctx) => {
  const read = await codeStep(ctx, "read", { items: ["a", "b"] }, Count);
  await codeStep(ctx, "echo", read, Count);
};

const countItems = (calls: string[]) => codeRoute("read", async (input: { items: string[] }) => (calls.push("read"), { count: input.items.length }));
const echo = codeRoute("echo", async (input: { count: number }) => input);
const hanging: StepRoute = { match: "echo", onRestart: "repeat", runner: { run: () => new Promise(() => undefined) } };

describe("code steps", () => {
  it("reports what a CodeStepFailure spent on the failed step, without a retry", async () => {
    const route = codeRecordRoute("read", async () => {
      throw new CodeStepFailure("over budget", { costUsd: 1.5 });
    });

    const outcome = await route.runner.run({ runId: "r", workflowName: "w", stepId: "read", iteration: 0, prompt: "{}", signal: new AbortController().signal, attempt: 0, requestKey: "k" });

    expect(outcome).toEqual({ ok: false, error: "over budget", retryable: false, usage: { costUsd: 1.5 } });
  });

  it("hands a body its JSON input and returns its answer to the workflow", async () => {
    const rt = runtime(makeDb(), [countItems([]), echo]);

    const run = await rt.wait(rt.start("count"));

    expect(run.status).toBe("completed");
    expect(recorded(run, "echo:0")).toEqual({ result: { count: 2 } });
  });

  it("stores the record the envelope hook builds around the body's answer", async () => {
    const envelope = (record: object, step: { stepId: string }) => ({ ...record, kind: `test.${step.stepId}` });
    const rt = runtime(makeDb(), [codeRoute("read", async () => ({ count: 1 }), { envelope }), echo]);

    const run = await rt.wait(rt.start("count"));

    expect(recorded(run, "read:0")).toEqual({ result: { count: 1 }, kind: "test.read" });
  });

  it("records a throw once as a non-retryable failure with its text rewritten", async () => {
    const calls: string[] = [];
    const failing = codeRoute("read", async () => (calls.push("read"), Promise.reject(new Error("token abc123"))), { errorText: (m) => m.replace("abc123", "[redacted]") });
    const rt = runtime(makeDb(), [failing, echo]);

    const run = await rt.wait(rt.start("count"));

    expect(run).toMatchObject({ status: "failed", error: expect.stringContaining("token [redacted]") });
    expect(JSON.stringify(run)).not.toContain("abc123");
    expect(calls).toEqual(["read"]);
  });

  it("replays a recorded step after a restart without calling its body again", async () => {
    const db = makeDb();
    const firstCalls: string[] = [];
    const first = runtime(db, [countItems(firstCalls), hanging]);
    const runId = first.start("count");
    await vi.waitFor(() => expect(Object.keys(first.status(runId)?.activeSteps ?? {})).toEqual(["echo"]));
    first.shutdown();

    const secondCalls: string[] = [];
    const second = runtime(db, [countItems(secondCalls), echo]);
    await second.hydrate();
    const run = await second.wait(runId);

    expect(run.status).toBe("completed");
    expect(recorded(run, "echo:0")).toEqual({ result: { count: 2 } });
    expect([firstCalls, secondCalls]).toEqual([["read"], []]);
  });

  it("stores a record route's trace keys beside its result", async () => {
    const rt = runtime(makeDb(), [codeRecordRoute("read", async () => ({ result: { count: 3 }, trace: ["t"] })), echo]);

    const run = await rt.wait(rt.start("count"));

    expect(recorded(run, "read:0")).toEqual({ result: { count: 3 }, trace: ["t"] });
    expect(recorded(run, "echo:0")).toEqual({ result: { count: 3 } });
  });
});
