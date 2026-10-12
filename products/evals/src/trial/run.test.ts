import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunResult, AgentUsage } from "@titan-design/agent";
import { afterEach, describe, expect, it } from "vitest";
import { caseHash, variantHash } from "../hash.js";
import { parseSpec } from "../spec/index.js";
import type { EvalCase, Spec, StepSpec, UnitSpec, VariantSpec } from "../spec/index.js";
import { readFixture } from "../test-fixtures.js";
import type { TrialTopology } from "./host.js";
import type { TrialLaunch } from "./routes.js";
import { runTrials, trialDirs, trialId, type RunTrialsOptions, type TrialDirs } from "./run.js";

const MODEL = "claude-sonnet-5-5";

function fixture<S extends Spec["schema"]>(path: string, schema: S): Extract<Spec, { schema: S }> {
  const spec = parseSpec(readFixture(path));
  if (!isSchema(spec, schema)) throw new Error(`${path} is ${spec.schema}, not ${schema}`);
  return spec;
}

function isSchema<S extends Spec["schema"]>(spec: Spec, schema: S): spec is Extract<Spec, { schema: S }> {
  return spec.schema === schema;
}

const unit: UnitSpec = fixture("unit.json", "titan.unit/v1");
const singlePass: VariantSpec = fixture("variants/single-pass.json", "titan.variant/v1");
const cases: EvalCase[] = [fixture("cases/no-actions.json", "titan.case/v1"), fixture("cases/standup-note.json", "titan.case/v1")];
const agentStep = {
  kind: "agent",
  runner: { via: "agent", harness: "claude-code" },
  model: MODEL,
  prompt: { path: "prompts/summarize.md", sha256: "e".repeat(64) },
  maxTurns: 4,
  maxBudgetUsd: 0.5,
  skills: [],
  onRestart: "repeat",
} satisfies StepSpec;
const variant: VariantSpec = { ...singlePass, id: "agent-pass", steps: { summarize: agentStep } };
const topology: TrialTopology = {
  steps: ["summarize"],
  run: async (ctx) => {
    await ctx.dispatch("summarize", "Summarize: {{note}}");
  },
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "evals-run-"));
  dirs.push(dir);
  return dir;
}

function usage(): AgentUsage {
  return { totalCostUsd: 0.02, modelUsage: {}, turns: 1, durationMs: 5 };
}

function answered(): AgentRunResult<unknown> {
  return { ok: true, output: "No action items.", sessionId: "s", usage: usage(), init: { model: MODEL, apiKeySource: undefined, tools: [], permissionMode: undefined, claudeCodeVersion: undefined } };
}

const rateLimited: AgentRunResult<unknown> = { ok: false, failure: { kind: "rate_limited", reason: "429" }, usage: usage() };

/** Counts launches per trial directory; `answer` decides each launch from the trial's launch count so far. */
function countingLaunches(answer: (count: number, request: Parameters<TrialLaunch>[0]) => Promise<AgentRunResult<unknown>>) {
  const counts = new Map<string, number>();
  const launchFor = (trial: TrialDirs): TrialLaunch => async (request) => {
    const count = (counts.get(trial.root) ?? 0) + 1;
    counts.set(trial.root, count);
    return answer(count, request);
  };
  return { counts, launchFor };
}

function options(dir: string, launchFor: RunTrialsOptions["launchFor"], signal?: AbortSignal): RunTrialsOptions {
  return { runDir: dir, runId: "run-1", unit, variants: [{ variant, topology }], cases, trials: 2, launchFor, signal };
}

function plannedIds(runId = "run-1"): string[] {
  return cases.flatMap((evalCase) => [0, 1].map((index) => trialId(variantHash(variant), caseHash(evalCase), index, runId)));
}

/** Resolves never, and rejects once the runtime shuts the step down, like a session cut off by a crash. */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("session cut off")), { once: true }));
}

describe("runTrials", () => {
  it("trial id is a pure function of variant, case, index and run id", () => {
    const id = trialId("v".repeat(64), "c".repeat(64), 0, "run-1");

    expect(trialId("v".repeat(64), "c".repeat(64), 0, "run-1")).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([id, trialId("v".repeat(64), "c".repeat(64), 1, "run-1"), trialId("v".repeat(64), "c".repeat(64), 0, "run-2"), trialId("w".repeat(64), "c".repeat(64), 0, "run-1")]).size).toBe(4);
  });

  it("gives each trial its own directory with a trial file, workspace, config dir and record", async () => {
    const dir = runDir();
    const { launchFor } = countingLaunches(async () => answered());

    const records = await runTrials(options(dir, launchFor));

    expect(records.map((record) => record.trialId)).toEqual(plannedIds());
    for (const id of plannedIds()) {
      const trial = trialDirs(dir, id);
      expect([trial.dbPath, trial.workspace, trial.configDir, trial.recordPath].every((path) => existsSync(path))).toBe(true);
    }
    expect(records.every((record) => record.outcome === "passed-run" && record.attempts.length === 1)).toBe(true);
  });

  it("a crashed run resumes and re-runs only unfinished trials", async () => {
    const dir = runDir();
    const crash = new AbortController();
    let launched = 0;
    const first = countingLaunches(async (_, request) => {
      launched += 1;
      if (launched < 3) return answered();
      crash.abort(new Error("crash"));
      return hangUntilAborted(request.signal);
    });

    await expect(runTrials(options(dir, first.launchFor, crash.signal))).rejects.toThrow("crash");
    const ids = plannedIds();
    expect(ids.map((id) => existsSync(trialDirs(dir, id).recordPath))).toEqual([true, true, false, false]);

    const second = countingLaunches(async () => answered());
    const records = await runTrials(options(dir, second.launchFor));

    expect(ids.map((id) => second.counts.get(trialDirs(dir, id).root) ?? 0)).toEqual([0, 0, 1, 1]);
    expect(records.map((record) => [record.trialId, record.outcome])).toEqual(ids.map((id) => [id, "passed-run"]));
    expect(records[2]?.attempts).toEqual([expect.objectContaining({ stepId: "summarize", attempt: 1, ok: true })]);
  });

  it("a crashed step that parks on restart makes the trial infra, so it is re-run from a fresh sandbox", async () => {
    const dir = runDir();
    const parking: VariantSpec = { ...variant, steps: { summarize: { ...agentStep, onRestart: "park" } } };
    const crash = new AbortController();
    const first = countingLaunches(async (_, request) => {
      crash.abort(new Error("crash"));
      return hangUntilAborted(request.signal);
    });
    const parkingOptions = (launchFor: RunTrialsOptions["launchFor"], signal?: AbortSignal) => ({ ...options(dir, launchFor, signal), variants: [{ variant: parking, topology }], cases: cases.slice(0, 1), trials: 1 });
    await expect(runTrials(parkingOptions(first.launchFor, crash.signal))).rejects.toThrow("crash");

    const second = countingLaunches(async () => answered());
    const [record] = await runTrials(parkingOptions(second.launchFor));

    expect([...second.counts.values()]).toEqual([1]);
    expect(record?.outcome).toBe("passed-run");
    expect(existsSync(join(dir, record?.trialId ?? "", "infra.json"))).toBe(true);
  });

  it("a settled run launches nothing when it is run again", async () => {
    const dir = runDir();
    const first = countingLaunches(async () => answered());
    const settled = await runTrials(options(dir, first.launchFor));

    const again = countingLaunches(async () => answered());
    const records = await runTrials(options(dir, again.launchFor));

    expect(again.counts.size).toBe(0);
    expect(records).toEqual(settled);
  });

  it("an infra trial is re-run once, then recorded infra", async () => {
    const dir = runDir();
    const { counts, launchFor } = countingLaunches(async () => rateLimited);

    const records = await runTrials({ ...options(dir, launchFor), cases: cases.slice(0, 1), trials: 1 });

    const [id] = plannedIds();
    expect(counts.get(trialDirs(dir, id ?? "").root)).toBe(2);
    expect(records.map((record) => record.outcome)).toEqual(["infra"]);
    expect(existsSync(join(trialDirs(dir, id ?? "").root, "infra.json"))).toBe(true);
  });

  it("an infra trial that passes on its re-run is recorded from the re-run", async () => {
    const dir = runDir();
    const { counts, launchFor } = countingLaunches(async (count) => (count === 1 ? rateLimited : answered()));

    const [record] = await runTrials({ ...options(dir, launchFor), cases: cases.slice(0, 1), trials: 1 });

    expect([...counts.values()]).toEqual([2]);
    expect(record?.outcome).toBe("passed-run");
    expect(record?.attempts).toHaveLength(1);
  });
});
