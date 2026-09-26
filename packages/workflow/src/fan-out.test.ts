import { SqliteGateStore, gateMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { mapItems, type MapOptions, type MapResult } from "./fan-out.js";
import { idempotentRunner, inlineRunner } from "./runners.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import type { StepRunInput, StepRunner, WorkflowFn } from "./types.js";

const LETTERS = "abcdefghij".split("");
const byLetter: MapOptions<string> = { key: (item) => item };

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3)]);
  return db;
}

function runtime(db: Db, runner: StepRunner): WorkflowRuntime {
  return new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, gatePollMs: 10 });
}

function judgeAll(items: string[], options: MapOptions<string>, sink: MapResult<string>[]): WorkflowFn {
  return async (ctx) => {
    sink.push(await mapItems(ctx, "judge", items, (item, stepId) => ctx.dispatch(stepId, `judge ${item}`), options));
  };
}

async function runOnce(runner: StepRunner, items: string[], options: MapOptions<string>): Promise<MapResult<string>> {
  const rt = runtime(makeDb(), runner);
  const sink: MapResult<string>[] = [];
  rt.register("fan", judgeAll(items, options, sink));
  const run = await rt.wait(rt.start("fan"));
  expect(run.status).toBe("completed");
  return sink[0]!;
}

describe("mapItems", () => {
  it("never has more items in flight than the concurrency cap", async () => {
    let inFlight = 0;
    let peak = 0;
    const runner = inlineRunner(async (input) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return input.prompt;
    });

    const out = await runOnce(runner, LETTERS, { ...byLetter, concurrency: 3 });

    expect(peak).toBe(3);
    expect(out.results.map((r) => r.result.output)).toEqual(LETTERS.map((l) => `judge ${l}`));
  });

  it("stops launching once finished items reach the budget and reports the rest as skipped", async () => {
    const run = vi.fn(async () => ({ ok: true as const, output: "ok", usage: { costUsd: 0.4 } }));

    const out = await runOnce({ run }, LETTERS, { ...byLetter, budgetUsd: 1 });

    expect(run).toHaveBeenCalledTimes(3);
    expect(out.stoppedBy).toBe("budget");
    expect(out.spentUsd).toBeCloseTo(1.2);
    expect(out.results.map((r) => r.key)).toEqual(["a", "b", "c"]);
    expect(out.skipped.map((s) => s.key)).toEqual(LETTERS.slice(3));
  });

  it("stops launching after a non-retryable step failure and reports the failure", async () => {
    const runner = inlineRunner((input) => {
      if (input.stepId === "judge/c") throw new Error("reader refused");
      return "ok";
    });

    const out = await runOnce(runner, LETTERS, byLetter);

    expect(out.stoppedBy).toBe("failure");
    expect(out.failed).toEqual([{ key: "c", item: "c", error: "reader refused", retryable: false }]);
    expect(out.skipped).toHaveLength(7);
  });

  it("records a retryable item failure and keeps launching the remaining items", async () => {
    const run = vi.fn(async (input: StepRunInput) =>
      input.stepId === "judge/c" ? { ok: false as const, error: "claude -p reached --max-turns 2", retryable: true } : { ok: true as const, output: "ok" });

    const out = await runOnce({ run }, LETTERS, byLetter);

    expect(out.stoppedBy).toBeNull();
    expect(out.failed).toEqual([{ key: "c", item: "c", error: "claude -p reached --max-turns 2", retryable: true }]);
    expect(out.results.map((r) => r.key)).toEqual(LETTERS.filter((l) => l !== "c"));
    expect(out.skipped).toEqual([]);
  });

  it("stops launching once retryable failures exceed maxFailures", async () => {
    const run = vi.fn(async () => ({ ok: false as const, error: "flaky", retryable: true }));

    const out = await runOnce({ run }, LETTERS, { ...byLetter, maxFailures: 2 });

    expect(out.stoppedBy).toBe("failure");
    expect(out.failed.map((f) => f.key)).toEqual(["a", "b", "c"]);
    expect(out.skipped.map((s) => s.key)).toEqual(LETTERS.slice(3));
  });

  it("counts the cost of every failed attempt in spentUsd and on the failure", async () => {
    const run = vi.fn(async (input: StepRunInput) =>
      input.stepId === "judge/b"
        ? { ok: false as const, error: "flaky", retryable: true, usage: { costUsd: 0.25 } }
        : { ok: true as const, output: "ok", usage: { costUsd: 0.1 } });

    const out = await runOnce({ run }, ["a", "b", "c"], byLetter);

    expect(out.failed).toEqual([{ key: "b", item: "b", error: "flaky", retryable: true, usage: { costUsd: 0.5 } }]);
    expect(out.spentUsd).toBeCloseTo(0.7);
  });

  it("rejects duplicate item keys before launching anything", async () => {
    const run = vi.fn(async () => ({ ok: true as const, output: "ok" }));
    const rt = runtime(makeDb(), { run });
    rt.register("fan", judgeAll(["a", "a"], byLetter, []));

    const finished = await rt.wait(rt.start("fan"));

    expect(finished).toMatchObject({ status: "failed", error: expect.stringContaining('duplicate item key "a"') });
    expect(run).not.toHaveBeenCalled();
  });

  it("resumes after a crash by item key, running only unfinished items even when the input is reordered", async () => {
    const db = makeDb();
    let firstCalls = 0;
    const first = runtime(db, idempotentRunner(inlineRunner((input) => {
      firstCalls += 1;
      return firstCalls === 5 ? new Promise<string>(() => undefined) : `verdict for ${input.prompt}`;
    })));
    first.register("fan", judgeAll(LETTERS, byLetter, []));
    const runId = first.start("fan");
    await vi.waitFor(() => expect(first.status(runId)?.activeSteps["judge/e"]).toBeDefined());
    first.shutdown();

    const resumedSteps: string[] = [];
    const second = runtime(db, idempotentRunner(inlineRunner((input) => {
      resumedSteps.push(input.stepId);
      return `verdict for ${input.prompt}`;
    })));
    const sink: MapResult<string>[] = [];
    second.register("fan", judgeAll([...LETTERS].reverse(), byLetter, sink));
    expect(await second.hydrate()).toEqual([runId]);
    expect(await second.wait(runId)).toMatchObject({ status: "completed" });

    expect(resumedSteps.sort()).toEqual(LETTERS.slice(4).map((l) => `judge/${l}`));
    for (const { item, result } of sink[0]!.results) expect(result.output).toBe(`verdict for judge ${item}`);
  });
});
