import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentFailure, AgentRunResult, AgentUsage } from "@titan-design/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { caseHash } from "../hash.js";
import { parseSpec } from "../spec/index.js";
import type { Spec, StepSpec, TrialRecord, VariantSpec } from "../spec/index.js";
import { readFixture } from "../test-fixtures.js";
import { startTrial } from "../trial.js";
import { createTrialHost, type TrialHost, type TrialTopology } from "./host.js";
import type { LaunchRequest, TrialLaunch } from "./routes.js";

const MODEL = "claude-sonnet-5-5";
function fixture<S extends Spec["schema"]>(path: string, schema: S): Extract<Spec, { schema: S }> {
  const spec = parseSpec(readFixture(path));
  if (!isSchema(spec, schema)) throw new Error(`${path} is ${spec.schema}, not ${schema}`);
  return spec;
}

function isSchema<S extends Spec["schema"]>(spec: Spec, schema: S): spec is Extract<Spec, { schema: S }> {
  return spec.schema === schema;
}

const unit = fixture("unit.json", "titan.unit/v1");
const singlePass = fixture("variants/single-pass.json", "titan.variant/v1");
const synthetic = fixture("cases/no-actions.json", "titan.case/v1");
const { note } = z.object({ note: z.string() }).parse(synthetic.input);
const agentStep = {
  kind: "agent",
  runner: { via: "agent", harness: "claude-code" },
  model: MODEL,
  prompt: { path: "prompts/summarize.md", sha256: "e".repeat(64) },
  maxTurns: 4,
  maxBudgetUsd: 0.5,
  allowedTools: ["Read"],
  skills: [],
  onRestart: "park",
} satisfies StepSpec;

const hosts: TrialHost[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function variantWith(steps: VariantSpec["steps"]): VariantSpec {
  return { ...singlePass, id: "under-test", steps };
}

function trialDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "evals-trial-"));
  dirs.push(dir);
  return join(dir, "trial.sqlite3");
}

function host(variant: VariantSpec, topology: TrialTopology, launch?: TrialLaunch): TrialHost {
  const opened = createTrialHost({ variant, topology, dbPath: trialDb(), launch });
  hosts.push(opened);
  return opened;
}

async function identity(variant: VariantSpec): Promise<TrialRecord> {
  return startTrial({ unit, variant, caseHash: caseHash(synthetic), startedAt: "2026-10-12T00:00:00Z", championOf: () => variant });
}

async function runOnce(variant: VariantSpec, topology: TrialTopology, launch?: TrialLaunch) {
  return host(variant, topology, launch).run({ trialId: "trial-1", identity: await identity(variant), params: { note } });
}

const summarizeOnce: TrialTopology = {
  steps: ["summarize"],
  run: async (ctx) => {
    await ctx.dispatch("summarize", "Summarize: {{note}}");
  },
};

function usage(cost: number): AgentUsage {
  const model = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: cost, contextWindow: 0, maxOutputTokens: 0 };
  return { totalCostUsd: cost, modelUsage: { [MODEL]: model }, turns: 2, durationMs: 10 };
}

function succeeded(model: string): AgentRunResult<unknown> {
  return { ok: true, output: "No action items.", sessionId: "session-1", usage: usage(0.03), init: { model, apiKeySource: undefined, tools: [], permissionMode: undefined, claudeCodeVersion: undefined } };
}

function failing(failure: AgentFailure): TrialLaunch {
  return async () => ({ ok: false, failure, usage: usage(0.01) });
}

/** Streams a read that succeeds and a grep that errors, then answers as `model`. */
function toolUsingLaunch(model: string) {
  return vi.fn(async (request: LaunchRequest) => {
    request.onMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read" }, { type: "tool_use", id: "t2", name: "Grep" }] } });
    request.onMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }, { type: "tool_result", tool_use_id: "t2", is_error: true }] } });
    return succeeded(model);
  });
}

describe("trial host", () => {
  it("runs a single-step code variant on a synthetic case with inlineRunner and records one attempt", async () => {
    const variant = variantWith({ summarize: { kind: "code", onRestart: "repeat" } });
    const topology = { ...summarizeOnce, code: { summarize: (input: { prompt: string }) => `summary of ${input.prompt}` } };

    const record = await runOnce(variant, topology);

    expect(record.outcome).toBe("passed-run");
    expect(record.output).toBe(`summary of Summarize: ${note}`);
    expect(record.attempts).toEqual([expect.objectContaining({ stepId: "summarize", attempt: 0, ok: true })]);
    expect(record.attempts[0]?.endedAt).toEqual(expect.any(String));
    expect(record.identity.variant).toBe((await identity(variant)).variant);
    expect(record.cost).toEqual({ usd: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0 });
  });

  it("refuses a variant with an unrouted step before the run starts", () => {
    const variant = variantWith({ summarize: { kind: "code", onRestart: "repeat" } });
    const topology: TrialTopology = { steps: ["summarize", "polish"], run: summarizeOnce.run, code: { summarize: () => "done" } };

    expect(() => createTrialHost({ variant, topology, dbPath: ":memory:" })).toThrow(/no route for polish/);
  });

  it("refuses gate and unit steps by name in E3", () => {
    const gate = variantWith({ approve: { kind: "gate" } });
    const child = variantWith({ delegate: { kind: "unit", unit: { id: "child", version: "1.0.0" }, variant: "champion" } });
    const topology: TrialTopology = { steps: [], run: async () => undefined };

    expect(() => createTrialHost({ variant: gate, topology, dbPath: ":memory:" })).toThrow(/step "approve" is a gate step/);
    expect(() => createTrialHost({ variant: child, topology, dbPath: ":memory:" })).toThrow(/step "delegate" is a unit step/);
  });

  it("fake agent launch: calls from tool_use blocks, cost from usage, model mismatch fails the trial", async () => {
    const variant = variantWith({ summarize: agentStep });
    const launch = toolUsingLaunch(MODEL);

    const record = await runOnce(variant, summarizeOnce, launch);

    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ stepId: "summarize", harness: "claude-code", model: MODEL, maxTurns: 4, maxBudgetUsd: 0.5, allowedTools: ["Read"], prompt: `Summarize: ${note}` }));
    expect(record.outcome).toBe("passed-run");
    expect(record.calls).toEqual([
      { stepId: "summarize", tool: "Read", isError: false },
      { stepId: "summarize", tool: "Grep", isError: true },
    ]);
    expect(record.cost).toEqual({ usd: 0.03, tokensIn: 100, tokensOut: 20, tokensCacheRead: 300 });
    expect(record.model).toBe(MODEL);

    const mismatched = await runOnce(variant, summarizeOnce, toolUsingLaunch("claude-haiku-5-5"));

    expect(mismatched.outcome).toBe("failed");
    expect(mismatched.model).toBe("claude-haiku-5-5");
    expect(mismatched.attempts).toEqual([expect.objectContaining({ ok: false, failure: "model_mismatch" })]);
  });

  it("launches an llm step as one claude-print turn with no tools", async () => {
    const launch = vi.fn(async () => succeeded(MODEL));

    const record = await runOnce(singlePass, summarizeOnce, launch);

    expect(record.outcome).toBe("passed-run");
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ harness: "claude-print", maxTurns: 1, maxBudgetUsd: 0.25, tools: [] }));
  });

  it("rate_limited is infra; max_turns is a variant failure", async () => {
    const variant = variantWith({ summarize: agentStep });

    const limited = await runOnce(variant, summarizeOnce, failing({ kind: "rate_limited", reason: "429" }));
    const exhausted = await runOnce(variant, summarizeOnce, failing({ kind: "max_turns", reason: "4 turns" }));

    expect(limited.outcome).toBe("infra");
    expect(limited.attempts).toHaveLength(1);
    expect(limited.cost.usd).toBe(0.01);
    expect(exhausted.outcome).toBe("failed");
    expect(exhausted.error).toMatch(/max_turns/);
  });

  it("refuses a model step when the host has no launch port", () => {
    expect(() => createTrialHost({ variant: singlePass, topology: summarizeOnce, dbPath: ":memory:" })).toThrow(/has no launch port/);
  });
});
