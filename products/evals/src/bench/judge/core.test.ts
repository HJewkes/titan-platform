import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACK_ARMS } from "../arms.js";
import { checkAnswer, claudePrintJudge, judgeRequest, pickJudges, renderPrompt, type JudgeQuestion } from "./core.js";

const runAgent = vi.fn();
afterEach(() => runAgent.mockReset());

const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

describe("pickJudges", () => {
  const anchor = TRACK_ARMS.p.find((arm) => arm.id === "O-med");
  const pairs = TRACK_ARMS.p.filter((arm) => arm !== anchor).map((arm) => [arm.id, [arm.model, anchor?.model ?? ""]] as const);
  const singles = TRACK_ARMS.r.map((arm) => [arm.id, [arm.model]] as const);

  it.each([...pairs, ...singles])("never lets %s's model judge or second-judge its own output", (_id, models) => {
    const { judge, second } = pickJudges(models);
    expect(models).not.toContain(judge.model);
    expect(models).not.toContain(second.model);
    expect(second.model).not.toBe(judge.model);
  });

  it.each([
    [[FABLE, OPUS], { model: SONNET, effort: "high" }, { model: HAIKU, effort: "high" }],
    [[OPUS, OPUS], { model: SONNET, effort: "high" }, { model: FABLE, effort: "medium" }],
    [[SONNET, OPUS], { model: FABLE, effort: "medium" }, { model: HAIKU, effort: "high" }],
    [[HAIKU, OPUS], { model: SONNET, effort: "high" }, { model: FABLE, effort: "medium" }],
    [[SONNET], { model: OPUS, effort: "medium" }, { model: FABLE, effort: "medium" }],
    [[OPUS], { model: SONNET, effort: "high" }, { model: FABLE, effort: "medium" }],
    [[HAIKU], { model: SONNET, effort: "high" }, { model: FABLE, effort: "medium" }],
    [[FABLE], { model: SONNET, effort: "high" }, { model: OPUS, effort: "medium" }],
  ])("follows the design's judge table for arms %j", (models, judge, second) => {
    expect(pickJudges(models)).toEqual({ judge, second });
  });
});

const question: JudgeQuestion = {
  instructions: "Judge it.",
  criteria: [
    { id: "covers", ask: "Covers what landed?" },
    { id: "overall", ask: "Closer to what landed?" },
  ],
  labels: ["A", "B", "tie"],
  decisive: "overall",
  texts: { "plan A": "slice one adds the parser", "plan B": "slice one adds the cache" },
  relabel: { A: "B", B: "A" },
};

describe("checkAnswer", () => {
  it("keeps quoted criteria and maps a swapped order back to canonical labels", () => {
    const answer = { criteria: [{ id: "covers", verdict: "A", cites: "plan A", evidence: "adds the parser" }, { id: "overall", verdict: "A", cites: "plan B", evidence: "adds the cache" }] };
    expect(checkAnswer(question, answer)).toMatchObject({ judgeErrors: 0, outcome: "B" });
  });

  it("drops a criterion whose quote is not in the text it cites, and counts a judge error", () => {
    const answer = { criteria: [{ id: "covers", verdict: "A", cites: "plan A", evidence: "adds the cache" }, { id: "overall", verdict: "tie", cites: "plan B", evidence: "adds the cache" }] };
    const checked = checkAnswer(question, answer);
    expect(checked.criteria.map((entry) => entry.id)).toEqual(["overall"]);
    expect(checked.judgeErrors).toBe(1);
    expect(checked.outcome).toBe("tie");
  });

  it("leaves no outcome when the decisive criterion cites a text the prompt never showed", () => {
    const answer = { criteria: [{ id: "overall", verdict: "A", cites: "the reference", evidence: "adds the cache" }] };
    expect(checkAnswer(question, answer)).toMatchObject({ criteria: [], judgeErrors: 2, outcome: null });
  });
});

describe("renderPrompt", () => {
  it("shows every criterion, label and cited text", () => {
    const prompt = renderPrompt(question);
    for (const fragment of ["covers: Covers what landed?", "A, B, tie", '<text name="plan B">', "slice one adds the parser"]) expect(prompt).toContain(fragment);
  });
});

describe("claudePrintJudge", () => {
  it("runs a tool-less claude-print call with the profile and effort in the env", async () => {
    runAgent.mockResolvedValue({ ok: true, output: { criteria: [] }, sessionId: "s1", usage: { totalCostUsd: 0.02 } });
    const judge = claudePrintJudge({ configDir: "/srv/x/profile", cwd: "/srv/x/missing-cwd", baseEnv: { PATH: "/usr/bin" }, run: runAgent });
    const call = await judge({ model: SONNET, effort: "high" }, judgeRequest(question));
    const env = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/srv/x/profile", CLAUDE_CODE_EFFORT_LEVEL: "high" };
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ harness: "claude-print", model: SONNET, cwd: "/srv/x/missing-cwd" }), { env });
    expect(runAgent).toHaveBeenCalledWith(expect.not.objectContaining({ tools: expect.anything() }), { env });
    expect(call).toEqual({ ok: true, answer: { criteria: [] }, costUsd: 0.02, sessionId: "s1", effortSeen: null });
  });

  it("reports a failed call with whatever it cost", async () => {
    runAgent.mockResolvedValue({ ok: false, failure: { kind: "schema_invalid", reason: "bad" }, usage: { totalCostUsd: 0.01 } });
    const call = await claudePrintJudge({ configDir: "/srv/x/profile", cwd: "/srv/x", run: runAgent })({ model: SONNET, effort: "high" }, judgeRequest(question));
    expect(call).toEqual({ ok: false, reason: "schema_invalid: bad", costUsd: 0.01 });
  });
});
