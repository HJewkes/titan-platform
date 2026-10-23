import { describe, expect, it } from "vitest";
import { cleanBeats, fakeRubricJudge } from "./cold-rubric-fakes.test-helpers.js";
import {
  CANARY_MAX_SCORE,
  COLD_RUBRIC_CANARIES,
  COLD_RUBRIC_DIMS,
  readColdRubric,
  runColdRubric,
  scoreCandidates,
  type ColdRubricDim,
  type ColdRubricResult,
  type RubricBeat,
  type SeriesVideo,
} from "./eval-cold-rubric.js";
import { readRubric, scriptRubricParts } from "./eval-evidence.js";
import type { JudgeHarness } from "./eval-harness.js";
import { SCRIPT_DIMS, l1EvalVersion, runL1 } from "./eval-judge.js";
import { deriveEvalView } from "./eval-view.js";
import { ScriptSchema } from "./script-schema.js";
import { fakeJudge, sonnet, twoChapters } from "./judge-fakes.test-helpers.js";

const score = (input: { beats?: RubricBeat[]; harness?: JudgeHarness; series?: SeriesVideo[]; run?: number } = {}) =>
  runColdRubric({
    subjectSha: "s1",
    beats: input.beats ?? cleanBeats(),
    rubric: readColdRubric(),
    series: input.series ?? [],
    judge: sonnet,
    harness: input.harness ?? fakeRubricJudge().harness,
    run: input.run ?? 1,
  });

const scores = (result: ColdRubricResult) => Object.fromEntries(result.dims.map((d) => [d.dim, d.verdict.score]));
const canaryFor = (dim: ColdRubricDim) => COLD_RUBRIC_CANARIES.find((c) => c.dim === dim)!;
/** The clean beats with one row's canary defect planted in them. */
const planted = (dim: ColdRubricDim): RubricBeat[] => canaryFor(dim).beats.map((beat, i) => ({ id: `p${i + 1}`, ...beat }));

/** The first run whose rotation places this row's canary. */
async function runWithCanary(dim: ColdRubricDim, harness: JudgeHarness): Promise<ColdRubricResult> {
  for (let run = 1; run < 200; run++) {
    const result = await score({ harness, run });
    if (result.canary.dim === dim) return result;
  }
  throw new Error(`no run places the ${dim} canary`);
}

describe("the five cold-viewer rows in l1-script.md", () => {
  const rubric = readRubric("l1-script.md");
  const { core, reported } = scriptRubricParts(rubric);

  it("lists J8 to J12 with anchors in the reported section, and none of them in judge A's rows", () => {
    for (const [dim, name] of [["J8", "Motivation"], ["J9", "Clarity"], ["J10", "Novelty"], ["J11", "Memorability"], ["J12", "Visual consistency"]]) {
      const row = reported.split("\n").find((line) => line.startsWith(`| ${dim} ${name} |`));
      expect(row, dim).toBeDefined();
      expect(row!.split("|").filter((cell) => cell.trim() !== "")).toHaveLength(5);
      expect(core).not.toContain(`| ${dim} `);
    }
    expect(reported).toContain("verbatim quote");
    expect(reported).toMatch(/reported only/);
  });

  it("keeps the reported rows out of judge A's prompt, schema and eval_version", async () => {
    const judge = fakeJudge();
    const rubrics = { beat: readRubric("l1-beat.md"), script: rubric };

    const result = await runL1({ scriptSha: "s1", beats: deriveEvalView(ScriptSchema.parse(twoChapters)), chapters: [["c1-1"], ["c2-1", "c2-2"]], rubrics, judge: sonnet, harness: judge.harness, run: 1 });

    expect(judge.calls.some((call) => call.includes("J8 Motivation"))).toBe(false);
    expect(result.script.map((s) => s.dim)).toEqual([...SCRIPT_DIMS]);
    expect(SCRIPT_DIMS.some((dim) => (COLD_RUBRIC_DIMS as readonly string[]).includes(dim))).toBe(false);
    expect(l1EvalVersion(rubrics, sonnet)).toBe(l1EvalVersion({ ...rubrics, script: core }, sonnet));
  });
});

describe("cold rubric scores", () => {
  it("scores all five rows with the quote each score rests on", async () => {
    const result = await score();

    expect(scores(result)).toEqual({ J8: 4, J9: 4, J10: 4, J11: 4, J12: 4 });
    expect(result.dims.every((d) => d.verdict.evidence === "c1-1:A courier prints")).toBe(true);
    expect(result.mode).toBe("reported");
  });

  it("voids a score whose quote is not in the beats", async () => {
    const result = await score({ harness: fakeRubricJudge({ evidence: "invented" }).harness });

    expect(result.dims.every((d) => d.verdict.score === null && d.verdict.void_reason === "quote not found in c1-1")).toBe(true);
  });

  // One canary test per row: the row's planted defect lowers that row and leaves the other four alone.
  it.each(COLD_RUBRIC_DIMS)("lowers %s, and only it, when its defect is planted", async (dim) => {
    const defect = planted(dim);
    const beats = dim === "J8" ? [...defect, ...cleanBeats()] : [...cleanBeats(), ...defect];

    const result = await score({ beats });

    expect(scores(result)[dim]).toBeLessThanOrEqual(CANARY_MAX_SCORE);
    expect(result.dims.filter((d) => d.dim !== dim).every((d) => d.verdict.score === 4)).toBe(true);
  });

  it("lowers novelty when a hook repeats an earlier video of the series, and lists the series in the prompt", async () => {
    const judge = fakeRubricJudge();
    const series = [{ promise: "How the desk refuses ghosts", hook: cleanBeats()[0]!.spoken, chapters: ["Why", "How"] }];

    const result = await score({ harness: judge.harness, series });

    expect(scores(result)).toMatchObject({ J10: 1, J8: 4 });
    expect(judge.calls[0]).toContain("1. How the desk refuses ghosts");
  });
});

describe("cold rubric canaries", () => {
  it.each(COLD_RUBRIC_DIMS)("trusts a judge that catches the %s canary", async (dim) => {
    const result = await runWithCanary(dim, fakeRubricJudge().harness);

    expect(result.canary).toMatchObject({ dim, pass: true });
    expect(result.trusted).toBe(true);
  });

  it.each(COLD_RUBRIC_DIMS)("distrusts a judge that misses the %s canary", async (dim) => {
    const result = await runWithCanary(dim, fakeRubricJudge({ lenient: true }).harness);

    expect(result.canary).toMatchObject({ dim, got: "4", pass: false });
    expect(result.trusted).toBe(false);
  });

  it("hides the canary under a nonce-chosen video name and beat ids", async () => {
    const judge = fakeRubricJudge();

    await score({ harness: judge.harness });

    expect(judge.calls[0]).toContain("### Video A");
    expect(judge.calls[0]).toContain("### Video B");
    expect(judge.calls[0]).not.toMatch(/canary|mechanism-first|jargon-wall/);
  });
});

describe("audition candidates", () => {
  it("scores every candidate, none skipped", async () => {
    const judge = fakeRubricJudge();
    const candidates = ["a", "b", "c"].map((id) => ({ id, sha: `sha-${id}`, beats: cleanBeats() }));

    const scored = await scoreCandidates(candidates, { rubric: readColdRubric(), series: [], judge: sonnet, harness: judge.harness, run: 1 });

    expect(scored.map((s) => s.candidate)).toEqual(["a", "b", "c"]);
    expect(judge.calls).toHaveLength(3);
    expect(scored.every((s) => s.rubric.dims.length === 5)).toBe(true);
  });
});
