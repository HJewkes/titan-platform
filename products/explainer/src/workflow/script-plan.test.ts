import type { AgentRunnerOptions, StepRunInput } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { loadBeatSpecs } from "../beat-load.js";
import { resolveBeats } from "../resolve-beat.js";
import { scriptBudgets } from "../resolve-budget.js";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { draftBudgets, draftRuntime, draftWordBudget } from "../script-budget.js";
import type { ScriptV1 } from "../script-schema.js";
import { shippedVisualRouter } from "../visual-router.js";
import { runVideo } from "./host.js";
import { fakeBridge, fakeHost, fakeScriptModel, fixture, type FakeScriptModel, type Fixture } from "./run-fakes.test-helpers.js";

let fx: Fixture | undefined;
afterEach(() => fx?.cleanup());

/** The parcel desk as a daily overview, every beat planned at `seconds`: 12 beats of about 22 words. */
const plannedAt = (seconds: number): ScriptV1 => {
  const script = choppy();
  return { ...script, profile: "daily-overview", beats: script.beats.map((beat) => ({ ...beat, plannedS: seconds })) };
};

/** A script model whose first reply keeps the script's own plannedS and whose later replies plan the prompt's runtime. */
function plansOnRetry(script: ScriptV1, options: { never?: boolean } = {}): FakeScriptModel {
  const under = fakeScriptModel(script, { asWritten: true });
  const planned = options.never ? under : fakeScriptModel(script);
  const prompts: string[] = [];
  const runnerFor = (runner: AgentRunnerOptions) => {
    const [first, later] = [under.runnerFor(runner), planned.runnerFor(runner)];
    return { run: (input: StepRunInput) => (prompts.push(input.prompt) === 1 ? first : later).run(input) };
  };
  return { runnerFor, prompts, budgets: [] };
}

const scriptRow = (result: Awaited<ReturnType<typeof runVideo>>) => result.report.rows.find((r) => r.stage === "script")!;

describe("the script stage's word-budget and runtime gates", () => {
  // Mutation: computing the cap from any other formula than resolve's scriptBudgets breaks the equality.
  it("holds a draft to the caps resolve computes for it", () => {
    const draft = plannedAt(5);
    const specs = loadBeatSpecs();

    const budgets = draftBudgets(draft);

    expect(budgets).toEqual(scriptBudgets(draft, resolveBeats(draft.beats, specs, shippedVisualRouter()), specs).rows);
  });

  it("fails an under-planned draft, naming each beat as words/cap and the planned total against the profile", () => {
    const draft = plannedAt(5);

    const words = draftWordBudget(draft);
    const runtime = draftRuntime(draft);

    expect(words.pass).toBe(false);
    expect(words.detail).toMatch(/^over: h1 \d+\/\d+ words \(5 s at [\d.]+ w\/s; \d+ words need \d+ s\);/);
    expect(runtime).toEqual({ pass: false, detail: "the beats plan 60 s; daily-overview runs 120-240 s, target 150 s" });
  });

  it("passes a draft planned to the profile's target with its words under every cap", () => {
    const draft = plannedAt(12.5);

    expect(draftWordBudget(draft)).toEqual({ pass: true, detail: "every beat and block within its cap" });
    expect(draftRuntime(draft).pass).toBe(true);
  });

  it("passes a draft inside a profile cut's band, below the profile's own floor", () => {
    const draft = { ...plannedAt(5), profile: "pr-overview" };

    expect(draftRuntime(draft)).toMatchObject({ pass: true, detail: expect.stringContaining("or 45-90 s as cut decision-brief") });
  });
});

describe("the script stage's plan retry", () => {
  it("names the word caps and target runtime in the prompt, retries once on an under-planned draft, and keeps the planned reply", async () => {
    fx = fixture();
    const model = plansOnRetry(plannedAt(5));

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, profile: "daily-overview", to: "script" }, fakeHost(fx, model, fakeBridge()));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts[0]).toContain("The beats' plannedS sum to about 150 s, and never below 120 s or above 240 s.");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toMatch(/The plan check failed:\n- h1 \d+\/\d+ words/);
    expect(model.prompts[1]).toContain("- runtime: the beats plan 60 s; daily-overview runs 120-240 s, target 150 s");
    expect(scriptRow(result)).toMatchObject({ calls: 2, retries: 1 });
  });

  // Mutation: dropping the word-budget gate from STAGE_CHECKS lets this run complete.
  it("fails the stage on its word-budget and runtime gates when the retry is no better", async () => {
    fx = fixture();
    const model = plansOnRetry(plannedAt(5), { never: true });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, profile: "daily-overview", to: "script" }, fakeHost(fx, model, fakeBridge()));

    expect(result.status).toBe("failed");
    expect(model.prompts).toHaveLength(2);
    expect(result.error).toContain("gate word-budget failed (over: h1 ");
    expect(result.error).toContain("; runtime failed (the beats plan 60 s;");
  });
});
