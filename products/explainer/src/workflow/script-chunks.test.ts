import type { AgentRunnerOptions, StepRunInput, StepRunOutcome } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import type { L0Check, L0Result } from "../eval-l0.js";
import { chapterScopedChecks, shippedRuleRegistry } from "../rules.js";
import { parseSpine } from "../spine-schema.js";
import { ScriptSchema } from "../script-schema.js";
import { runScriptStage, StageFailure, type ModelStageInput } from "./model-stages.js";
import { CHUNK_OVER_CHAPTERS, isChunked } from "./script-chunks.js";
import { SPINE } from "./run-fakes.test-helpers.js";

// A synthetic lantern workshop, one chapter per lamp part; nothing here quotes a real video.
const chapterIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `ch${i + 1}`);

function spineOf(chapters: number): string {
  const rows = chapterIds(chapters).map((id) => `| ${id} | Why does part ${id} matter? | §3 |`);
  return `${SPINE}\n## 8. Chapter order\n| Ch | Question | Rows |\n|---|---|---|\n${rows.join("\n")}\n`;
}

const FACTS = "# Facts\n\n| Id | Claim |\n|---|---|\n| F1 | Every lamp passes the bench. |\n";
/** F2 is placed in ch2 and F3 in ch3 by their Beats cells; F1 names no beat, so every chapter may cite it. */
const PLACED_FACTS = `# Facts\n\n| Id | Claim | Beats |\n|---|---|---|\n| F1 | Every lamp passes the bench. | |\n| F2 | A wick burns for six hours. | r2-wick |\n| F3 | The glass holds at 300 degrees. | r3-glass, ch3-b |\n`;

const VIDEO = {
  audience: "TODO: audience",
  stake: "TODO: stake",
  promise: "You can tell which lamps the bench trusts",
  thesis_mechanism: "the bench tests every wick before it lights",
  running_example: "TODO: example",
  simplifications: [],
  close_type: "callback",
  glossary: [{ name: "wick", job: "carries the flame" }],
};

const beatOf = (id: string, chapter: string, spoken: string) => ({
  id,
  chapter,
  function: "WHAT",
  mode: "explain",
  plannedS: 8,
  spoken,
  fact_ids: ["F1"],
  visual: { assertion: "The bench tests each wick", job: "numbers" },
});

/** A chapter's reply: the first holds the video, a later one only the glossary it adds. */
function chapterReply(chapter: string, spoken = "The bench tests the wick first."): Record<string, unknown> {
  const first = chapter === "ch1";
  return {
    schema: "script/v1",
    id: "lantern-v1",
    profile: "repo-tour",
    facts_pack: "facts.md",
    video: first ? VIDEO : { glossary: [{ name: `${chapter} glass`, job: "shields the flame" }] },
    chapters: [{ id: chapter, label: `${chapter} label`, question: `Why does part ${chapter} matter?` }],
    beats: [beatOf(`${chapter}-a`, chapter, spoken), beatOf(`${chapter}-b`, chapter, "So the lamp lights only when it is safe.")],
  };
}

type Answer = (prompt: string) => unknown;

interface Model {
  prompts: string[];
  /** Each call's system prompt, by call order; undefined where the call sent none. */
  systems: (string | undefined)[];
  runnerFor: (options: AgentRunnerOptions) => { run: (input: StepRunInput) => Promise<StepRunOutcome> };
}

function fakeModel(answer: Answer, usd = 0.01): Model {
  const prompts: string[] = [];
  const systems: (string | undefined)[] = [];
  const usage = { costUsd: usd, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWrite1hTokens: 4 };
  const runnerFor = (options: AgentRunnerOptions) => ({
    run: async (input: StepRunInput): Promise<StepRunOutcome> => {
      prompts.push(input.prompt);
      systems.push(options.defaults?.systemPrompt);
      return { ok: true, output: JSON.stringify(answer(input.prompt)), usage };
    },
  });
  return { prompts, systems, runnerFor };
}

const taskChapter = (prompt: string): string => /## Task: chapter (\S+),/.exec(prompt)?.[1] ?? "none";
const isRepair = (prompt: string): boolean => prompt.includes("## Checks the draft fails");

/** Fails a chapter-scoped rule on every beat that speaks "BROKEN", and a whole-video one while no beat says "lantern". */
const markerChecks: L0Check[] = [
  ({ script }) => {
    const beats = script.beats.filter((beat) => beat.spoken.includes("BROKEN")).map((beat) => beat.id);
    return [row("Q-E4", beats)];
  },
  ({ script }) => [row("Q-F3", script.beats.some((beat) => beat.spoken.includes("lantern")) ? [] : [script.beats[0]!.id])],
];

function row(check_id: string, beats: string[]): L0Result {
  return { check_id, mode: "tagged", severity: "error", value: beats.length, threshold: 0, pass: beats.length === 0, detail_beats: beats };
}

function stageInput(spine: string, remainingUsd = 5, facts = FACTS): ModelStageInput & { read: (sha: string) => string } {
  const texts = new Map<string, string>([["spine-sha", spine], ["facts-sha", facts]]);
  const store = {
    readText: (sha: string) => texts.get(sha)!,
    putText: (text: string) => {
      const sha = `sha-${texts.size}`;
      texts.set(sha, text);
      return sha;
    },
  };
  return { artifacts: { spine: "spine-sha", facts: "facts-sha" }, store, from: { runId: "r1", stage: "script" }, remainingUsd, read: store.readText };
}

const LONG = CHUNK_OVER_CHAPTERS + 1;

async function runStage(spine: string, model: Model, l0Checks: readonly L0Check[] = [], remainingUsd = 5, facts = FACTS) {
  const input = stageInput(spine, remainingUsd, facts);
  const outcome = await runScriptStage(input, { model: "fake", runnerFor: model.runnerFor, l0Checks });
  return { outcome, script: ScriptSchema.parse(JSON.parse(input.read(outcome.outputs.draft!))) };
}

const passingVideo = (prompt: string): unknown => (taskChapter(prompt) === "ch1" ? chapterReply("ch1", "The lantern bench tests the wick.") : chapterReply(taskChapter(prompt)));

describe("chunked script drafting", () => {
  it("drafts a long spine in one call per chapter, each given the shared context and what is written so far", async () => {
    const model = fakeModel(passingVideo);

    const { outcome } = await runStage(spineOf(LONG), model, markerChecks);

    expect(model.prompts.map(taskChapter)).toEqual(chapterIds(LONG));
    const third = model.prompts[2]!;
    expect(model.systems[2]).toContain("## Story spine (spine.md)");
    expect(third).toContain("## Facts pack (facts.md)");
    expect(third).toContain("## Written so far");
    expect(third).toContain("The last beat written: ch2-b");
    expect(third).toContain('"thesis_mechanism":"the bench tests every wick before it lights"');
    expect(third).toContain("ch2 glass");
    expect(third).toContain("hands off to ch4");
    expect(model.prompts[0]).not.toContain("## Written so far");
    expect(outcome.notes).toContain("chapter ch3: 1 call(s), $0.0100, cache 10 read, 4 written; 0 -> 0 failing chapter checks");
    expect(outcome.usage?.calls).toBe(LONG);
  });

  it("repairs a chapter-local failure in that chapter's own call and leaves every other chapter as drafted", async () => {
    const model = fakeModel((prompt) => {
      const chapter = taskChapter(prompt);
      if (chapter === "ch3" && !isRepair(prompt)) return chapterReply("ch3", "The BROKEN bench skips the wick.");
      return chapter === "ch1" ? chapterReply("ch1", "The lantern bench tests the wick.") : chapterReply(chapter);
    });

    const { script, outcome } = await runStage(spineOf(LONG), model, markerChecks);

    const repairs = model.prompts.filter(isRepair);
    expect(repairs.map(taskChapter)).toEqual(["ch3"]);
    expect(repairs[0]).toContain("- Q-E4:");
    expect(repairs[0]).toContain("beats: ch3-a;");
    expect(script.beats.find((beat) => beat.id === "ch3-a")?.spoken).toBe("The bench tests the wick first.");
    expect(script.beats.find((beat) => beat.id === "ch4-a")?.spoken).toBe("The bench tests the wick first.");
    expect(outcome.notes).toContain("chapter ch3: 2 call(s), $0.0200, cache 20 read, 8 written; 1 -> 0 failing chapter checks");
  });

  it("joins the chapters in the spine's order, keeping every beat id, and gathers each chapter's glossary", async () => {
    const { script } = await runStage(spineOf(LONG), fakeModel(passingVideo), markerChecks);

    expect(script.chapters.map((chapter) => chapter.id)).toEqual(chapterIds(LONG));
    expect(script.beats.map((beat) => beat.id)).toEqual(chapterIds(LONG).flatMap((id) => [`${id}-a`, `${id}-b`]));
    expect(script.video.glossary.map((entry) => entry.name)).toEqual(["wick", ...chapterIds(LONG).slice(1).map((id) => `${id} glass`)]);
  });

  it("leaves a whole-video failure out of the chapter rounds and gives it one round on the joined script, patching only the named beats", async () => {
    const patch = { beats: [{ ...beatOf("ch5-a", "ch5", "The lantern bench tests the wick first.") }] };
    const model = fakeModel((prompt) => (prompt.includes("## Task: the joined script") ? patch : chapterReply(taskChapter(prompt))));

    const { script, outcome } = await runStage(spineOf(LONG), model, markerChecks);

    expect(model.prompts.filter(isRepair)).toEqual([]);
    expect(model.prompts.filter((prompt) => prompt.includes("## Task: the joined script"))).toHaveLength(1);
    expect(script.beats.find((beat) => beat.id === "ch5-a")?.spoken).toContain("lantern");
    expect(script.beats.filter((beat) => beat.spoken.includes("lantern"))).toHaveLength(1);
    expect(outcome.notes).toContain("whole video: 1 call(s), $0.0100, cache 10 read, 4 written; 1 -> 0 failing error checks");
  });

  it("stops at the run's spend cap between chapter calls, keeping the spend so far", async () => {
    const failure = await runStage(spineOf(LONG), fakeModel(passingVideo, 1), markerChecks, 2).catch((error: unknown) => error);

    if (!(failure instanceof StageFailure)) throw new Error("expected a StageFailure");
    expect(failure.message).toContain("spend cap stopped the chunked draft at chapter ch3");
    expect(failure.message).toContain("after chapter ch1: 1 call(s), $1.0000, cache 10 read, 4 written; 0 -> 0 failing chapter checks; chapter ch2:");
    expect(failure.usage.usd).toBe(2);
  });

  it("keeps a short spine on the single-call path", async () => {
    const whole = { ...chapterReply("ch1"), chapters: chapterIds(4).map((id) => ({ id, label: id, question: `Why does part ${id} matter?` })), beats: chapterIds(4).map((id) => beatOf(`${id}-a`, id, "The bench tests the wick first.")) };
    const model = fakeModel(() => whole);

    await runStage(spineOf(4), model);

    expect(isChunked(parseSpine(spineOf(4)))).toBe(false);
    expect(model.prompts[0]).toContain("Write the whole script/v1 for this video");
    expect(model.prompts[0]).toContain("## Story spine (spine.md)");
    expect(model.prompts[0]).toContain("| F1 | Every lamp passes the bench. |");
    expect(model.systems.filter((system) => system !== undefined)).toEqual([]);
    expect(model.prompts.filter((prompt) => prompt.includes("## Task: chapter"))).toEqual([]);
  });

  it("sends every chunked call the same shared prefix as its own system prompt, and none of it in the call's prompt", async () => {
    const model = fakeModel((prompt) => (prompt.includes("## Task: the joined script") ? { beats: [] } : passingVideo(prompt)));

    await runStage(spineOf(LONG), model, markerChecks);

    const prefix = model.systems[0]!;
    expect(model.systems).toEqual(model.prompts.map(() => prefix));
    expect(prefix).toContain("## Story spine (spine.md)");
    expect(prefix).toContain("## The script/v1 JSON Schema");
    expect(prefix).not.toContain("## Facts pack");
    expect(model.prompts.filter((prompt) => prompt.includes("## Story spine (spine.md)"))).toEqual([]);
  });

  it("gives each chapter call only the facts placed in that chapter or in none, and the whole-video round every fact", async () => {
    const model = fakeModel((prompt) => (prompt.includes("## Task: the joined script") ? { beats: [] } : chapterReply(taskChapter(prompt))));

    await runStage(spineOf(LONG), model, markerChecks, 5, PLACED_FACTS);

    const factIds = (prompt: string) => ["F1", "F2", "F3"].filter((id) => prompt.includes(`| ${id} |`));
    const byChapter = new Map(model.prompts.filter((prompt) => !isRepair(prompt)).map((prompt) => [taskChapter(prompt), factIds(prompt)]));
    expect(byChapter.get("ch2")).toEqual(["F1", "F2"]);
    expect(byChapter.get("ch3")).toEqual(["F1", "F3"]);
    expect(byChapter.get("ch5")).toEqual(["F1"]);
    expect(byChapter.get("none")).toEqual(["F1", "F2", "F3"]);
  });
});

describe("rule scope", () => {
  it("reads Q-E4 as chapter-local and Q-F3 as whole-video from rules.yaml", () => {
    const scoped = chapterScopedChecks(shippedRuleRegistry());

    expect(scoped.has("Q-E4")).toBe(true);
    expect(scoped.has("Q-F3")).toBe(false);
  });
});
