import type { AgentRunnerOptions, StepRunInput, StepRunOutcome } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import type { L0Check, L0Result } from "../eval-l0.js";
import { chapterScopedChecks, shippedRuleRegistry } from "../rules.js";
import { draftWordBudget } from "../script-budget.js";
import { parseSpine } from "../spine-schema.js";
import { BEAT_FUNCTIONS, CHIP_KINDS, ScriptSchema, type ScriptV1 } from "../script-schema.js";
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
      if (chapter === "ch3") return isRepair(prompt) ? { beats: [beatOf("ch3-a", "ch3", "The bench tests the wick first.")] } : chapterReply("ch3", "The BROKEN bench skips the wick.");
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

  it("re-times a beat its chapter repair pushed one word over its cap, with no extra call, so the word-budget gate passes", async () => {
    const overByOne = "The bench tests the wick first, then the glass, then the hook, and only then does the lamp go out to the shop.";
    const model = fakeModel((prompt) => {
      const chapter = taskChapter(prompt);
      if (chapter === "ch3") return isRepair(prompt) ? { beats: [beatOf("ch3-a", "ch3", overByOne)] } : chapterReply("ch3", "The BROKEN bench skips the wick.");
      return chapter === "ch1" ? chapterReply("ch1", "The lantern bench tests the wick.") : chapterReply(chapter);
    });

    const { script, outcome } = await runStage(spineOf(LONG), model, markerChecks);

    expect(model.prompts).toHaveLength(LONG + 1);
    expect(script.beats.find((beat) => beat.id === "ch3-a")).toMatchObject({ spoken: overByOne, plannedS: 9 });
    expect(draftWordBudget(script).pass).toBe(true);
    expect(outcome.checks).toContainEqual({ name: "word-budget-retime", gate: false, pass: true, detail: "re-timed 1 beat(s) to fit their words: ch3-a 8→9 s" });
    expect(outcome.notes).toContain("word-budget re-time: ch3-a 8→9 s");
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

  it("names each finished chapter's spend and cache tokens when a later chapter's reply never parses", async () => {
    const model = fakeModel((prompt) => (taskChapter(prompt) === "ch3" ? { chapters: [] } : passingVideo(prompt)));

    const failure = await runStage(spineOf(LONG), model, markerChecks).catch((error: unknown) => error);

    if (!(failure instanceof StageFailure)) throw new Error("expected a StageFailure");
    expect(failure.message).toContain("script: chapter ch3:");
    expect(failure.message).toContain("after chapter ch1: 1 call(s), $0.0100, cache 10 read, 4 written; 0 -> 0 failing chapter checks; chapter ch2:");
    expect(failure.message).toContain("chapter ch3 so far: 2 call(s), $0.0200, cache 20 read, 8 written");
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
    expect(prefix).toContain("## Rules for the script stage");
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

/** ch3's draft: its first beat fails Q-E4, its second carries a chip and a glossary-free name to prove it is left alone. */
function brokenCh3(): Record<string, unknown> {
  const second = { ...beatOf("ch3-b", "ch3", "So the lamp lights only when it is safe."), plannedS: 11, visual: { assertion: "The lamp waits", job: "numbers", chips: [chip("verified", "Bench log")] } };
  return { ...chapterReply("ch3"), beats: [beatOf("ch3-a", "ch3", "The BROKEN bench skips the wick."), second, beatOf("ch3-c", "ch3", "Then the glass goes on.")] };
}

/** The script/v1 JSON of the draft a repair prompt shows. */
const draftIn = (prompt: string): ScriptV1 => ScriptSchema.parse(JSON.parse(/## Your draft\n\n```json\n(.*)\n```/.exec(prompt)![1]!));
const isPatchAsk = (prompt: string): boolean => prompt.includes('"beats" lists exactly the beats');
/** Q-W10 names a chapter, not a beat: here every chapter one of whose beats speaks "STALL". */
const chapterWideCheck: L0Check = ({ script }) => [row("Q-W10", [...new Set(script.beats.filter((beat) => beat.spoken.includes("STALL")).map((beat) => beat.chapter))])];

// Synthetic bench rows for one list beat; the list slot schema holds five.
const BENCH_ROWS = ["wick tested", "glass tested", "hook tested", "base tested", "cap tested", "seal tested", "lamp boxed"];

/** ch3-a drawn as a list of `rows`, cued at a word it speaks. */
const listBeat = (rows: readonly string[]) => ({
  ...beatOf("ch3-a", "ch3", "The bench tests the wick first."),
  visual: { assertion: "The bench tests each wick", job: "numbers", beat: "list", labels: [...rows], cues: [{ action: "V6", target: "rows-1", atCue: "bench" }] },
});

/** ch3's chapter reply with ch3-a as a list of `rows`. */
const ch3With = (rows: readonly string[]): Record<string, unknown> => {
  const reply = chapterReply("ch3");
  return { ...reply, beats: [listBeat(rows), (reply.beats as unknown[])[1]] };
};

const isPlanRetry = (prompt: string): boolean => prompt.includes("The plan check failed");
const isJoined = (prompt: string): boolean => prompt.includes("## Task: the joined script");

describe("the template fill on the chunked path", () => {
  it("names a chapter's 7-row list in its plan retry and answers it as a template-fill row in the chapter's repair", async () => {
    // Arrange
    const model = fakeModel((prompt) => {
      const chapter = taskChapter(prompt);
      if (chapter === "ch3") return isRepair(prompt) ? { beats: [listBeat(BENCH_ROWS.slice(0, 5))] } : ch3With(BENCH_ROWS);
      return chapter === "ch1" ? chapterReply("ch1", "The lantern bench tests the wick.") : chapterReply(chapter);
    });

    // Act
    const { script, outcome } = await runStage(spineOf(LONG), model, markerChecks);

    // Assert
    const ch3 = model.prompts.filter((prompt) => taskChapter(prompt) === "ch3");
    expect(ch3.filter(isPlanRetry)[0]).toMatch(/- template fill: ch3-a \(list\): .*<=5 items/);
    const repair = ch3.find(isRepair)!;
    expect(repair).toContain("- template-fill: a beat's labels fit its beat spec's slots;");
    expect(repair).toContain("beats: ch3-a;");
    expect(outcome.notes).toContain("chapter ch3: 3 call(s), $0.0300, cache 30 read, 12 written; 1 -> 0 failing chapter checks");
    expect(script.beats.find((beat) => beat.id === "ch3-a")?.visual.labels).toHaveLength(5);
  });

  it("gives a 7-row list the chapter rounds left to the whole-video round as a template-fill row, and keeps its patch", async () => {
    // Arrange
    const model = fakeModel((prompt) => {
      if (isJoined(prompt)) return { beats: [listBeat(BENCH_ROWS.slice(0, 5))] };
      const chapter = taskChapter(prompt);
      if (chapter === "ch3") return isRepair(prompt) ? { beats: [listBeat(BENCH_ROWS)] } : ch3With(BENCH_ROWS);
      return chapter === "ch1" ? chapterReply("ch1", "The lantern bench tests the wick.") : chapterReply(chapter);
    });

    // Act
    const { script, outcome } = await runStage(spineOf(LONG), model, markerChecks);

    // Assert
    const joined = model.prompts.filter(isJoined);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatch(/- template-fill: .*\(beats: ch3-a; measured 1, needs 0\)\n {2}Found: template fill: ch3-a \(list\)/);
    expect(outcome.notes).toContain("chapter ch3: 4 call(s), $0.0400, cache 40 read, 16 written; 1 -> 1 failing chapter checks");
    expect(outcome.notes).toContain("whole video: 1 call(s), $0.0100, cache 10 read, 4 written; 1 -> 0 failing error checks");
    expect(script.beats.find((beat) => beat.id === "ch3-a")?.visual.labels).toHaveLength(5);
  });
});

describe("beat-level chapter repair", () => {
  // Mutation: taking the patch as the whole chapter, not splicing it in place, loses ch3-b and ch3-c.
  it("asks only for the failing beat and splices the reply in place, every other beat byte-identical", async () => {
    const fixed = beatOf("ch3-a", "ch3", "The bench tests the wick first.");
    const model = fakeModel((prompt) => (taskChapter(prompt) !== "ch3" ? passingVideo(prompt) : isRepair(prompt) ? { beats: [fixed] } : brokenCh3()));

    const { script, outcome } = await runStage(spineOf(LONG), model, markerChecks);

    const repair = model.prompts.find(isRepair)!;
    expect(repair).toContain('"beats" lists exactly the beats ch3-a, in that order');
    expect(repair).not.toContain("Reply with the whole corrected object.");
    const drafted = draftIn(repair).beats;
    const ch3 = script.beats.filter((beat) => beat.chapter === "ch3");
    expect(ch3.map((beat) => beat.id)).toEqual(["ch3-a", "ch3-b", "ch3-c"]);
    expect(ch3[0]!.spoken).toBe("The bench tests the wick first.");
    expect(ch3.slice(1).map((beat) => JSON.stringify(beat))).toEqual(drafted.slice(1).map((beat) => JSON.stringify(beat)));
    expect(outcome.notes).toContain("chapter ch3: 2 call(s), $0.0200, cache 20 read, 8 written; 1 -> 0 failing chapter checks");
  });

  // Mutation: returning undefined from `idFault` merges the extra ch3-b (or the empty patch) and the chapter reads 1 -> 0.
  it.each([
    ["adds a beat id", { beats: [beatOf("ch3-a", "ch3", "The bench tests the wick first."), beatOf("ch3-b", "ch3", "A new second beat.")] }, "names beats it was not asked for: ch3-b"],
    ["drops the asked beat id", { beats: [] }, "leaves out ch3-a"],
  ])("rejects and retries a patch that %s, never merging it", async (_case, patch, why) => {
    const model = fakeModel((prompt) => (taskChapter(prompt) !== "ch3" ? passingVideo(prompt) : isRepair(prompt) ? patch : brokenCh3()));

    const { script, outcome } = await runStage(spineOf(LONG), model, markerChecks);

    const ch3Calls = model.prompts.filter((prompt) => taskChapter(prompt) === "ch3");
    expect(ch3Calls.filter((prompt) => prompt.includes("## Your previous reply was rejected"))).toHaveLength(2);
    const retry = ch3Calls.find((prompt) => prompt.includes("## Your previous reply was rejected"))!;
    expect(retry).toContain(why);
    expect(retry.slice(retry.indexOf("## Your previous reply was rejected"))).toContain('"beats" lists exactly the beats ch3-a, in that order');
    expect(retry).not.toContain("Reply with the whole corrected object.");
    expect(script.beats.filter((beat) => beat.chapter === "ch3").map((beat) => [beat.id, beat.spoken])).toEqual([
      ["ch3-a", "The BROKEN bench skips the wick."],
      ["ch3-b", "So the lamp lights only when it is safe."],
      ["ch3-c", "Then the glass goes on."],
    ]);
    expect(outcome.notes).toContain("chapter ch3: 5 call(s), $0.0500, cache 50 read, 20 written; 1 -> 1 failing chapter checks");
  });

  it("falls back to the whole chapter when a failing row names the chapter rather than a beat", async () => {
    const model = fakeModel((prompt) => {
      if (taskChapter(prompt) !== "ch3") return passingVideo(prompt);
      return isRepair(prompt) ? chapterReply("ch3", "The bench tests the wick first.") : chapterReply("ch3", "The STALL bench is BROKEN.");
    });

    const { script, outcome } = await runStage(spineOf(LONG), model, [...markerChecks, chapterWideCheck]);

    const repairs = model.prompts.filter(isRepair);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toContain("beats: ch3;");
    expect(repairs[0]).toContain("Reply with the whole corrected object.");
    expect(isPatchAsk(repairs[0]!)).toBe(false);
    expect(script.beats.find((beat) => beat.id === "ch3-a")?.spoken).toBe("The bench tests the wick first.");
    expect(outcome.notes).toContain("chapter ch3: 2 call(s), $0.0200, cache 20 read, 8 written; 2 -> 0 failing chapter checks");
  });

  // Mutation: changing the repair prompt's default ask to a patch ask fails the whole-object match here.
  it("keeps the short-script single-call repair asking for and keeping the whole object", async () => {
    const broken = wholeReply({ spoken: "The BROKEN bench skips the wick." });
    const replies = [broken, wholeReply()];
    const model = fakeModel(() => replies.shift() ?? wholeReply());

    const { script } = await runStage(spineOf(4), model, [markerChecks[0]!]);

    const repairs = model.prompts.filter(isRepair);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatch(/Fix what these checks name and keep the rest\. Reply with the whole corrected object\.\n$/);
    expect(isPatchAsk(repairs[0]!)).toBe(false);
    expect(script.beats.map((beat) => beat.spoken)).toEqual(chapterIds(4).map(() => "The bench tests the wick first."));
  });
});

/** A short spine's whole reply, its first beat's visual and fields overridden. */
function wholeReply(beat: Record<string, unknown> = {}, visual: Record<string, unknown> = {}): Record<string, unknown> {
  const beats = chapterIds(4).map((id) => beatOf(`${id}-a`, id, "The bench tests the wick first."));
  const first = { ...beats[0]!, ...beat, visual: { ...beats[0]!.visual, ...visual } };
  return { ...chapterReply("ch1"), chapters: chapterIds(4).map((id) => ({ id, label: id, question: `Why does part ${id} matter?` })), beats: [first, ...beats.slice(1)] };
}

const chip = (kind: string, text: string) => ({ kind, text });
/** The schema retry, not the plan retry a short synthetic runtime also draws. */
const isRetry = (prompt: string): boolean => prompt.includes("## Your previous reply was rejected") && !prompt.includes("The plan check failed");

describe("out-of-enum values in a script reply", () => {
  // Mutation: making `enumFix` return undefined for a list item sends ch3 to the retry, which fails on the same chips.
  it("drops a chapter's chips whose kind is outside the enum, keeps its beats, and names each dropped chip in a note", async () => {
    const [a, b] = [beatOf("ch3-a", "ch3", "The bench tests the wick first."), beatOf("ch3-b", "ch3", "So the lamp lights only when it is safe.")];
    const badChips = {
      ...chapterReply("ch3"),
      beats: [
        { ...a, visual: { ...a.visual, chips: [chip("rumor", "Heard at the bench"), chip("verified", "Bench log")] } },
        { ...b, visual: { ...b.visual, chips: [chip("guess", "Maybe six hours")] } },
      ],
    };
    const model = fakeModel((prompt) => (taskChapter(prompt) === "ch3" ? badChips : passingVideo(prompt)));

    const { script, outcome } = await runStage(spineOf(LONG), model, markerChecks);

    expect(model.prompts.filter((prompt) => taskChapter(prompt) === "ch3")).toHaveLength(1);
    expect(script.beats.find((beat) => beat.id === "ch3-a")?.visual.chips).toEqual([chip("verified", "Bench log")]);
    expect(script.beats.find((beat) => beat.id === "ch3-b")?.visual.chips).toEqual([]);
    expect(outcome.notes).toContain(`chapter ch3: dropped beats.0.visual.chips.0: kind: "rumor" is not one of ${CHIP_KINDS.join(", ")}`);
    expect(outcome.notes).toContain(`chapter ch3: dropped beats.1.visual.chips.0: kind: "guess" is not one of ${CHIP_KINDS.join(", ")}`);
  });

  it("drops an optional field's out-of-enum value on the single-call path, with a note and no retry", async () => {
    const model = fakeModel(() => wholeReply({}, { layer: "sky", chips: [chip("rumor", "Heard at the bench")] }));

    const { script, outcome } = await runStage(spineOf(4), model);

    expect(model.prompts.filter(isRetry)).toEqual([]);
    expect(script.beats[0]?.visual).not.toHaveProperty("layer");
    expect(script.beats[0]?.visual.chips).toEqual([]);
    expect(outcome.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^dropped beats\.0\.visual\.layer: "sky" is not one of /), expect.stringMatching(/^dropped beats\.0\.visual\.chips\.0: kind: "rumor"/)]));
  });

  // Mutation: dropping `raw` from `issueText` in `parsedObject` leaves zod's message, which names neither the bad value nor this wording.
  it("names each bad value and the values the schema allows in the retry when a required field is out of the enum", async () => {
    const replies = [wholeReply({ function: "MAYBE" }, { chips: [chip("rumor", "Heard at the bench")] }), wholeReply()];
    const model = fakeModel(() => replies.shift() ?? wholeReply());

    const { script } = await runStage(spineOf(4), model);

    const retry = model.prompts.find(isRetry);
    expect(retry).toContain(`beats.0.function: "MAYBE" is not one of ${BEAT_FUNCTIONS.join(", ")}`);
    expect(retry).toContain(`beats.0.visual.chips.0.kind: "rumor" is not one of ${CHIP_KINDS.join(", ")}`);
    expect(script.beats.map((beat) => beat.id)).toEqual(chapterIds(4).map((id) => `${id}-a`));
  });

  // Mutation: letting `enumFix` drop an item of a required list (beats) loses the beat silently and the stage passes.
  it("fails the stage when a required field stays out of the enum after the retry, rather than dropping it", async () => {
    const model = fakeModel(() => wholeReply({ function: "MAYBE" }));

    const failure = await runStage(spineOf(4), model).catch((error: unknown) => error);

    if (!(failure instanceof StageFailure)) throw new Error("expected a StageFailure");
    expect(model.prompts.filter(isRetry)).toHaveLength(1);
    expect(failure.message).toContain(`beats.0.function: "MAYBE" is not one of ${BEAT_FUNCTIONS.join(", ")}`);
  });
});

describe("rule scope", () => {
  it("reads Q-E4 as chapter-local and Q-F3 as whole-video from rules.yaml", () => {
    const scoped = chapterScopedChecks(shippedRuleRegistry());

    expect(scoped.has("Q-E4")).toBe(true);
    expect(scoped.has("Q-F3")).toBe(false);
  });
});
