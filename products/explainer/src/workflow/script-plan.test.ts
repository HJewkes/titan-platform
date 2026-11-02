import type { AgentRunnerOptions, StepRunInput } from "@titan-design/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { loadBeatSpecs } from "../beat-load.js";
import { resolveBeats } from "../resolve-beat.js";
import { scriptBudgets } from "../resolve-budget.js";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { budgetSection, draftBeatLengths, draftBudgets, draftRuntime, draftWordBudget, planFaults } from "../script-budget.js";
import type { ScriptV1 } from "../script-schema.js";
import { shippedVisualRouter } from "../visual-router.js";
import { runVideo } from "./host.js";
import { fakeRender, fakeHost, fakeScriptModel, fixture, type FakeScriptModel, type Fixture } from "./run-fakes.test-helpers.js";

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

/** A script model that answers its first prompt with `first` and every later one with `later`, both as written. */
function repliesInTurn(first: ScriptV1, later: ScriptV1): FakeScriptModel {
  const [opening, rest] = [fakeScriptModel(first, { asWritten: true }), fakeScriptModel(later, { asWritten: true })];
  const prompts: string[] = [];
  const runnerFor = (runner: AgentRunnerOptions) => {
    const [one, two] = [opening.runnerFor(runner), rest.runnerFor(runner)];
    return { run: (input: StepRunInput) => (prompts.push(input.prompt) === 1 ? one : two).run(input) };
  };
  return { runnerFor, prompts, budgets: [] };
}

// Synthetic dock rows for one chapter's list; no label quotes a real run.
const DOCK_ROWS = ["dock 1 · Parcels sorted", "dock 2 · Night crew in", "dock 3 · Scanner fixed", "dock 4 · Bay cleared", "dock 5 · Labels printed", "dock 6 · Van loaded", "dock 7 · Shift closed"];

const firstWord = (spoken: string): string => spoken.split(" ")[0]!.replace(/\W/g, "").toLowerCase();

/** The planned draft with h1 drawn as a list of `h1Rows`, and h2, its chapter's continuation, as a list of `h2Rows`. */
function withLists(h1Rows: string[], h2Rows: string[]): ScriptV1 {
  const draft = plannedAt(12.5);
  const labels: Record<string, string[]> = { h1: h1Rows, h2: h2Rows };
  const asList = (beat: ScriptV1["beats"][number], rows: string[]) => ({
    ...beat,
    visual: { ...beat.visual, beat: "list", labels: rows, cues: [...beat.visual.cues, { action: "V6" as const, target: "rows-1", atCue: firstWord(beat.spoken) }] },
  });
  return { ...draft, beats: draft.beats.map((beat) => (labels[beat.id] ? asList(beat, labels[beat.id]!) : beat)) };
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
    expect(runtime).toEqual({ pass: false, detail: "the beats plan 60 s; daily-overview runs 120-240 s, target 180 s" });
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

  it("fails a public plan past its split line with the episodes to split it into, by chapter, rather than trimming it", () => {
    const draft = { ...plannedAt(40), profile: "repo-argument" };

    const runtime = draftRuntime(draft);

    expect(runtime.pass).toBe(false);
    expect(runtime.detail).toBe(
      "the beats plan 480 s; repo-argument runs 210-300 s, target 240 s; past 360 s it splits into episodes at chapter breaks, not a trim: episode 1: ch1, ch2 (240 s); episode 2: ch3, ch4 (240 s)",
    );
  });

  it("names a chapter too long for one episode as the one to split by section", () => {
    const planned = { ...plannedAt(40), profile: "repo-argument" };
    const draft = { ...planned, beats: planned.beats.map((beat) => (beat.chapter === "ch1" ? { ...beat, plannedS: 110 } : beat)) };

    const runtime = draftRuntime(draft);

    expect(runtime.detail).toMatch(/episode 1: ch1 \(330 s, so split ch1 by section\); episode 2: ch2, ch3 \(240 s\); episode 3: ch4 \(120 s\)$/);
  });

  it("names no split for a plan over its band but under its split line", () => {
    const draft = { ...plannedAt(27), profile: "repo-argument" };

    const runtime = draftRuntime(draft);

    expect(runtime).toEqual({ pass: false, detail: "the beats plan 324 s; repo-argument runs 210-300 s, target 240 s" });
  });
});

describe("the script stage's beat plan", () => {
  it("splits the target evenly when the chapters are not the profile's fixed blocks", () => {
    const list = loadBeatSpecs().get("list")!;
    const leads = ["ch1", "ch2", "ch3", "ch4"].map((chapter) => ({ chapter, spec: list }));

    const section = budgetSection(leads, "daily-overview");

    expect(section).toContain("every beat but the close plans 6-20 s, so a chapter of chapterS seconds holds ceil(chapterS / 20) beats or more.");
    expect(section).toContain("at least: ch1 3 (45 s), ch2 3 (45 s), ch3 3 (45 s), ch4 3 (45 s). Plan at least 12 beats in all.");
  });

  // Mutation: an even share per chapter gives every chapter 23 s and 2 beats, so lanes gets no more beats than ask.
  it("gives the daily's lanes chapter more beats than its ask, by goal-walk's block shares", () => {
    const list = loadBeatSpecs().get("list")!;
    const leads = ["ch1", "ch2", "ch3", "ch4", "ch5", "ch6", "ch7", "ch8"].map((chapter) => ({ chapter, spec: list }));

    const section = budgetSection(leads, "daily-overview");

    expect(section).toContain("at least: ch1 1 (13 s), ch2 1 (16 s), ch3 4 (72 s), ch4 2 (31 s), ch5 1 (9 s), ch6 1 (14 s), ch7 1 (18 s), ch8 1 (7 s). Plan at least 12 beats in all.");
  });

  // Mutation: dropping the beat-length faults from planFaults passes this draft to L0, where Q-F8 fails it unrepaired.
  it("fails a chapter planned as one 45 s beat, naming the beat and the split it needs", () => {
    const draft = plannedAt(12.5);
    const chapter = draft.beats[1]!.chapter;
    const first = draft.beats.find((beat) => beat.chapter === chapter)!;
    const oneBeat = { ...draft, beats: draft.beats.flatMap((beat) => (beat.chapter !== chapter ? [beat] : beat === first ? [{ ...beat, plannedS: 45 }] : [])) };

    const verdict = draftBeatLengths(oneBeat);

    expect(verdict).toEqual({ pass: false, detail: `out of band: ${first.id} (${chapter}) plans 45 s; a beat runs 6-20 s, so ${chapter}'s 45 s splits into at least 3 beats` });
    expect(planFaults(oneBeat)).toContain(`beat length: ${first.id} (${chapter}) plans 45 s; a beat runs 6-20 s, so ${chapter}'s 45 s splits into at least 3 beats`);
  });

  it("passes a draft whose every beat is within the band", () => {
    expect(draftBeatLengths(plannedAt(12.5))).toEqual({ pass: true, detail: "every beat within 6-20 s" });
  });
});

describe("the script stage's plan retry", () => {
  it("names the word caps and target runtime in the prompt, retries once on an under-planned draft, and keeps the planned reply", async () => {
    fx = fixture();
    const model = plansOnRetry(plannedAt(5));

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, profile: "daily-overview", to: "script" }, fakeHost(fx, model, fakeRender()));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts[0]).toContain("The beats' plannedS sum to about 180 s, and never below 120 s or above 240 s.");
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toMatch(/The plan check failed:\n- h1 \d+\/\d+ words/);
    expect(model.prompts[1]).toContain("- runtime: the beats plan 60 s; daily-overview runs 120-240 s, target 180 s");
    expect(scriptRow(result)).toMatchObject({ calls: 2, retries: 1 });
  });

  it("re-times a draft whose only fault is a beat a word or two over its cap, with no plan retry", async () => {
    fx = fixture();
    const draft = { ...plannedAt(12.5), beats: plannedAt(12.5).beats.map((beat) => (beat.id === "h1" ? { ...beat, plannedS: 9 } : beat)) };
    expect(planFaults(draft)).toEqual(["h1 26/25 words (9 s at 2.8 w/s; 26 words need 10 s)"]);
    const model = fakeScriptModel(draft, { asWritten: true });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, profile: "daily-overview", to: "script" }, fakeHost(fx, model, fakeRender()));

    expect(result.status, result.error).toBe("completed");
    expect(model.prompts).toHaveLength(1);
    expect(scriptRow(result)).toMatchObject({ calls: 1, retries: 0 });
  });

  // Mutation: dropping the word-budget gate from STAGE_CHECKS lets this run complete.
  // Mutation: dropping the fill faults from planFaults passes the 7-label list, so no retry is asked for.
  it("retries once naming a 7-label list resolve's template fill refuses, and keeps the reply that moves rows to the continuation", async () => {
    // Arrange
    fx = fixture();
    const overflow = withLists(DOCK_ROWS, []);
    const split = withLists(DOCK_ROWS.slice(0, 4), DOCK_ROWS.slice(4));
    const model = repliesInTurn(overflow, split);

    // Act
    const result = await runVideo({ spine: fx.spine, facts: fx.facts, profile: "daily-overview", to: "script" }, fakeHost(fx, model, fakeRender()));

    // Assert
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toMatch(/The plan check failed:\n- template fill: h1 \(list\): .*<=5 items/);
    expect(model.prompts[1]).toContain("A beat whose labels overflow its beat spec keeps that many labels and moves the rest to a continuation beat in the same chapter.");
    expect(scriptRow(result)).toMatchObject({ calls: 2, retries: 1 });
    expect(result.status, result.error).toBe("completed");
  });

  it("answers a fill fault the plan retry left in an L0 repair round, naming the refused beat, and keeps the repair", async () => {
    // Arrange
    fx = fixture();
    const overflow = withLists(DOCK_ROWS, []);
    const model = fakeScriptModel(overflow, { asWritten: true, repaired: withLists(DOCK_ROWS.slice(0, 4), DOCK_ROWS.slice(4)) });

    // Act
    const result = await runVideo({ spine: fx.spine, facts: fx.facts, profile: "daily-overview", to: "script" }, fakeHost(fx, model, fakeRender()));

    // Assert
    expect(model.prompts).toHaveLength(3);
    expect(model.prompts[2]).toContain("- template-fill: a beat's labels fit its beat spec's slots;");
    expect(model.prompts[2]).toMatch(/\(beats: h1; measured 1, needs 0\)\n {2}Found: template fill: h1 \(list\): .*<=5 items/);
    expect(result.status, result.error).toBe("completed");
  });

  it("fails the stage on its word-budget and runtime gates when the retry is no better", async () => {
    fx = fixture();
    const model = plansOnRetry(plannedAt(5), { never: true });

    const result = await runVideo({ spine: fx.spine, facts: fx.facts, profile: "daily-overview", to: "script" }, fakeHost(fx, model, fakeRender()));

    expect(result.status).toBe("failed");
    expect(model.prompts).toHaveLength(2);
    expect(result.error).toContain("gate word-budget failed (over: h1 ");
    expect(result.error).toContain("; runtime failed (the beats plan 60 s;");
  });
});
