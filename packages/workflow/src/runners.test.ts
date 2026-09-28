import type { AgentRunDeps } from "@titan-design/agent";
import { SqliteGateStore, gateMigration, gateResolverMigration } from "@titan-design/hitl/sqlite";
import { openDatabase, runMigrations, type Db } from "@titan-design/store-sqlite";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { agentRunner, idempotentRunner, inlineRunner } from "./runners.js";
import { routedRunner } from "./routed-runner.js";
import { WorkflowRuntime } from "./runtime.js";
import { workflowMigration, workflowOwnershipMigration } from "./store.js";
import { StepOutputInvalidError, type StepRunner, type WorkflowFn } from "./types.js";

function makeDb(): Db {
  const db = openDatabase(":memory:");
  runMigrations(db, [gateMigration(1), workflowMigration(2), workflowOwnershipMigration(3), gateResolverMigration(4)]);
  return db;
}

function runtime(db: Db, runner: StepRunner): WorkflowRuntime {
  return new WorkflowRuntime({ db, gates: new SqliteGateStore(db, { migrate: false }), runner, gatePollMs: 10 });
}

const oneDispatch: WorkflowFn = async (ctx) => {
  await ctx.dispatch("work", "read-only judgement");
};

function structuredQuery(structured: unknown, result: Record<string, unknown> = {}): NonNullable<AgentRunDeps["query"]> {
  const messages = [
    { type: "system", subtype: "init", apiKeySource: "none", model: "claude-sonnet-5", tools: [], permissionMode: "dontAsk", claude_code_version: "2.1.300", session_id: "sess-1" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      duration_ms: 10,
      result: "",
      structured_output: structured,
      total_cost_usd: 0.12,
      modelUsage: { "claude-sonnet-5": { inputTokens: 900, outputTokens: 80, costUSD: 0.12 } },
      session_id: "sess-1",
      ...result,
    },
  ];
  return (() => {
    async function* generate() {
      yield* messages;
    }
    return Object.assign(generate(), { close: () => undefined });
  }) as unknown as NonNullable<AgentRunDeps["query"]>;
}

describe("idempotentRunner", () => {
  it("redispatches a step that was in flight at a crash, once, and completes the run", async () => {
    const db = makeDb();
    const first = runtime(db, idempotentRunner(inlineRunner(() => new Promise<string>(() => undefined))));
    first.register("once", oneDispatch);
    const runId = first.start("once");
    await vi.waitFor(() => expect(first.status(runId)?.activeSteps.work).toBeDefined());
    first.shutdown();

    const redo = vi.fn(() => "judged");
    const second = runtime(db, idempotentRunner(inlineRunner(redo)));
    second.register("once", oneDispatch);

    expect(await second.hydrate()).toEqual([runId]);
    expect(await second.wait(runId)).toMatchObject({ status: "completed", stepResults: { "work:0": { output: "judged" } } });
    expect(redo).toHaveBeenCalledTimes(1);
  });

  it("carries the live runner's usage onto the step result", async () => {
    const rt = runtime(makeDb(), idempotentRunner({ run: async () => ({ ok: true, output: "ok", usage: { costUsd: 0.3 } }) }));
    rt.register("once", oneDispatch);

    const run = await rt.wait(rt.start("once"));

    expect(run.stepResults["work:0"]?.usage).toEqual({ costUsd: 0.3 });
  });

  it("a resumed run reports the cost of an attempt that failed before the crash exactly once", async () => {
    const db = makeDb();
    const failThenHang = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "flaky", retryable: true, usage: { costUsd: 0.25 } })
      .mockReturnValue(new Promise(() => undefined));
    const first = runtime(db, idempotentRunner({ run: failThenHang }));
    first.register("once", oneDispatch);
    const runId = first.start("once");
    await vi.waitFor(() => expect(first.status(runId)?.activeSteps.work?.attempt).toBe(1));
    first.shutdown();
    const second = runtime(db, idempotentRunner({ run: async () => ({ ok: true, output: "ok", usage: { costUsd: 0.1 } }) }));
    second.register("once", oneDispatch);

    await second.hydrate();
    const run = await second.wait(runId);

    expect(run.stepResults["work:0"]?.usage?.costUsd).toBeCloseTo(0.35);
  });
});

describe("step retries", () => {
  it("a step that fails once then succeeds reports the cost of both attempts", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "flaky", retryable: true, usage: { costUsd: 0.25, inputTokens: 100, outputTokens: 10 } })
      .mockResolvedValueOnce({ ok: true, output: "ok", usage: { costUsd: 0.1, inputTokens: 50, outputTokens: 5 } });
    const rt = runtime(makeDb(), { run });
    rt.register("once", oneDispatch);

    const finished = await rt.wait(rt.start("once"));

    expect(run).toHaveBeenCalledTimes(2);
    expect(finished.stepResults["work:0"]?.usage).toEqual({ costUsd: 0.35, inputTokens: 150, outputTokens: 15 });
  });

  it("a retried step whose failed attempt reported no cost reports only the success", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "flaky", retryable: true })
      .mockResolvedValueOnce({ ok: true, output: "ok", usage: { costUsd: 0.1 } });
    const rt = runtime(makeDb(), { run });
    rt.register("once", oneDispatch);

    const finished = await rt.wait(rt.start("once"));

    expect(finished.stepResults["work:0"]?.usage).toEqual({ costUsd: 0.1 });
  });
});

describe("agentRunner", () => {
  it("returns schema output as parseable JSON with the run's cost and tokens", async () => {
    const runner = agentRunner({
      cwd: "/tmp",
      maxTurns: 1,
      maxBudgetUsd: 1,
      defaults: { outputSchema: z.object({ verdict: z.string() }) },
      deps: { query: structuredQuery({ verdict: "confirmed" }), env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-oauth" } },
    });

    const outcome = await runner.run({ runId: "r", workflowName: "w", stepId: "s", iteration: 0, prompt: "judge", signal: new AbortController().signal });

    expect(outcome.ok && JSON.parse(outcome.output)).toEqual({ verdict: "confirmed" });
    expect(outcome.ok && outcome.usage).toEqual({ costUsd: 0.12, inputTokens: 900, outputTokens: 80 });
  });

  const stepInput = { runId: "r", workflowName: "w", stepId: "s", iteration: 0, prompt: "judge", signal: new AbortController().signal };
  const oauth = { CLAUDE_CODE_OAUTH_TOKEN: "sk-oauth" };

  it("uses the step's schema when the runner has no default schema", async () => {
    const runner = agentRunner({ cwd: "/tmp", maxTurns: 1, maxBudgetUsd: 1, deps: { query: structuredQuery({ verdict: "confirmed" }), env: oauth } });

    const outcome = await runner.run({ ...stepInput, outputSchema: z.object({ verdict: z.string() }) });

    expect(outcome.ok && JSON.parse(outcome.output)).toEqual({ verdict: "confirmed" });
  });

  it("prefers the step's schema over the runner's default schema", async () => {
    const runner = agentRunner({ cwd: "/tmp", maxTurns: 1, maxBudgetUsd: 1, defaults: { outputSchema: z.object({ score: z.number() }) }, deps: { query: structuredQuery({ verdict: "confirmed" }), env: oauth } });

    const outcome = await runner.run({ ...stepInput, outputSchema: z.object({ verdict: z.string() }) });

    expect(outcome.ok && JSON.parse(outcome.output)).toEqual({ verdict: "confirmed" });
  });

  it("fails a step as StepOutputInvalidError when the agent reports schema_invalid, without a retry", async () => {
    const query = vi.fn(structuredQuery({ verdict: 3 }));
    const agent = agentRunner({ cwd: "/tmp", maxTurns: 1, maxBudgetUsd: 1, deps: { query, env: oauth } });
    const run = vi.spyOn(agent, "run");
    let caught: unknown;
    const review: WorkflowFn = async (ctx) => {
      try {
        await ctx.dispatch("review", "review it", { schema: z.object({ verdict: z.string() }) });
      } catch (error) {
        caught = error;
        throw error;
      }
    };
    const rt = runtime(makeDb(), routedRunner([{ match: "review", onRestart: "repeat", runner: agent }]));
    rt.register("review", review);

    const finished = await rt.wait(rt.start("review"));

    expect(finished.status).toBe("failed");
    expect(run).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(StepOutputInvalidError);
    expect(caught).toMatchObject({ kind: "schema", retryable: false, usage: { costUsd: 0.12 } });
    expect((caught as StepOutputInvalidError).message).toContain("verdict");
    expect((caught as StepOutputInvalidError).message).not.toContain("3");
  });

  it("fails a step as StepOutputInvalidError when a legacy agentRunner reports schema_invalid", async () => {
    const agent = agentRunner({ cwd: "/tmp", maxTurns: 1, maxBudgetUsd: 1, deps: { query: structuredQuery({ verdict: 3 }), env: oauth } });
    const run = vi.spyOn(agent, "run");
    const rt = runtime(makeDb(), agent);
    rt.register("review", async (ctx) => {
      await ctx.dispatch("review", "review it", { schema: z.object({ verdict: z.string() }) }).catch((error: unknown) => {
        expect(error).toBeInstanceOf(StepOutputInvalidError);
        throw error;
      });
    });

    const finished = await rt.wait(rt.start("review"));

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/output schema/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reports a failed run's cost on a retryable failure", async () => {
    const failedResult = { subtype: "error_during_execution", is_error: true, errors: ["socket hang up"] };
    const runner = agentRunner({
      cwd: "/tmp",
      maxTurns: 1,
      maxBudgetUsd: 1,
      deps: { query: structuredQuery(undefined, failedResult), env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-oauth" } },
    });

    const outcome = await runner.run({ runId: "r", workflowName: "w", stepId: "s", iteration: 0, prompt: "judge", signal: new AbortController().signal });

    expect(outcome).toMatchObject({ ok: false, retryable: true, usage: { costUsd: 0.12, inputTokens: 900, outputTokens: 80 } });
  });

  it("routes steps to the claude-print harness when the defaults select it", async () => {
    const query = vi.fn();
    const runner = agentRunner({
      cwd: "/tmp",
      maxTurns: 1,
      maxBudgetUsd: 1,
      defaults: { harness: "claude-print" },
      deps: { query, env: { PATH: "/nonexistent" } },
    });

    const outcome = await runner.run({ runId: "r", workflowName: "w", stepId: "s", iteration: 0, prompt: "judge", signal: new AbortController().signal });

    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining("claude binary not found on PATH") });
    expect(query).not.toHaveBeenCalled();
  });
});
