import { describe, expect, it } from "vitest";
import { readRubric } from "./eval-evidence.js";
import type { JudgeHarness } from "./eval-harness.js";
import { L1_CANARIES, l1EvalVersion, runL1, type L1Input } from "./eval-judge.js";
import { deriveEvalView } from "./eval-view.js";
import { ScriptSchema } from "./script-schema.js";
import { fakeJudge, promptBeats, sonnet, twoChapters } from "./judge-fakes.test-helpers.js";

const rubrics = { beat: readRubric("l1-beat.md"), script: readRubric("l1-script.md") };
const beats = deriveEvalView(ScriptSchema.parse(twoChapters));
const input = (harness: JudgeHarness, run = 1): L1Input => ({
  scriptSha: "0123456789ab",
  beats,
  chapters: [["c1-1"], ["c2-1", "c2-2"]],
  rubrics,
  judge: sonnet,
  harness,
  run,
});

describe("runL1", () => {
  it("scores every real beat on B1–B6 and the script on J1–J7 when each verdict quotes its beat", async () => {
    const result = await runL1(input(fakeJudge().harness));

    expect(result.beats).toHaveLength(3 * 6);
    expect(result.beats.every((b) => b.verdict.score === 1 && b.verdict.void_reason === null)).toBe(true);
    expect(result.script.map((s) => s.verdict.score)).toEqual([4, 4, 4, 4, 4, 4, 4]);
    expect(result.trusted).toBe(true);
    expect(result.spend).toEqual({ usd: 0.03, tokensIn: 300, tokensOut: 60 });
  });

  it("voids a score that carries no quote, so it never counts", async () => {
    const result = await runL1(input(fakeJudge({ evidence: "none" }).harness));

    expect(result.beats.every((b) => b.verdict.score === null && b.verdict.void_reason === "no evidence")).toBe(true);
    expect(result.script.every((s) => s.verdict.score === null)).toBe(true);
  });

  it("voids a score whose quote is not in the beat it cites", async () => {
    const result = await runL1(input(fakeJudge({ evidence: "invented" }).harness));

    expect(result.beats[0]!.verdict).toMatchObject({ score: null, void_reason: "quote not found in c1-1" });
  });

  it("puts exactly one canary last in every beat call, so no real beat follows it, and keeps it out of the score rows", async () => {
    const { harness, calls } = fakeJudge();

    const result = await runL1(input(harness));

    const beatCalls = calls.filter((prompt) => prompt.includes("# L1 beat rubric"));
    expect(beatCalls).toHaveLength(2);
    for (const prompt of beatCalls) {
      const canaries = L1_CANARIES.filter((c) => prompt.includes(c.spoken));
      expect(canaries).toHaveLength(1);
      expect(promptBeats(prompt).at(-1)!.spoken).toBe(canaries[0]!.spoken);
    }
    expect(new Set(result.beats.map((b) => b.beat))).toEqual(new Set(["c1-1", "c2-1", "c2-2"]));
    expect(result.canaries.map((c) => c.canary).sort()).toEqual(["master-key-filler", "master-key-filler", "process-narration"]);
  });

  it("does not trust a run whose judge passes a canary", async () => {
    const result = await runL1(input(fakeJudge({ lenient: true }).harness));

    expect(result.trusted).toBe(false);
    expect(result.canaries.every((c) => c.got === "pass" && !c.pass)).toBe(true);
  });

  it("voids the beats of a failed call and does not trust the run", async () => {
    const failing: JudgeHarness = async () => ({ ok: false, reason: "auth_misconfigured: not logged in", usd: 0, tokensIn: 0, tokensOut: 0 });

    const result = await runL1(input(failing));

    expect(result.beats[0]!.verdict.void_reason).toBe("call failed: auth_misconfigured: not logged in");
    expect(result.failures).toHaveLength(3);
    expect(result.trusted).toBe(false);
  });
});

describe("l1EvalVersion", () => {
  it("changes when a rubric is edited or the judge model changes, not when only the budget does", () => {
    const base = l1EvalVersion(rubrics, sonnet);

    expect(l1EvalVersion({ ...rubrics, beat: `${rubrics.beat}\nOne more rule.` }, sonnet)).not.toBe(base);
    expect(l1EvalVersion(rubrics, { ...sonnet, model: "haiku" })).not.toBe(base);
    expect(l1EvalVersion(rubrics, { ...sonnet, provider: "codex" })).not.toBe(base);
    expect(l1EvalVersion(rubrics, { ...sonnet, max_budget_usd: 2 })).toBe(base);
  });
});
