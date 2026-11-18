import { describe, expect, it } from "vitest";
import { TIE } from "../judge/batch.js";
import { checkAnswer, renderPrompt } from "../judge/core.js";
import type { PlanCase } from "./cases.js";
import { ANCHOR_ARM, pairKey, planControls, planPairItems, storedPlans, type PlanJudgeSource } from "./judge.js";

const planText = (name: string, titles: string[]): string =>
  `Plan ${name}.\n\`\`\`json\n${JSON.stringify({ slices: titles.map((title) => ({ title, owns: [`src/${title}/**`], estimate: 1, tests: [`${title}.test.ts: works`] })) })}\n\`\`\``;

const PLANS: Record<string, string> = {
  "plans/s1.md": planText("north-1", ["parse", "wire", "docs", "cli"]),
  "plans/s2.md": planText("south-1", ["all"]),
  "plans/s3.md": planText("north-2", ["store", "read"]),
  "plans/s4.md": planText("south-2-retry", ["store"]),
};
const source: PlanJudgeSource = { plan: (file) => PLANS[file] ?? "", reference: (caseId) => `landed reference for ${caseId}` };

const caseOf = (id: string): PlanCase => ({ id, hash: `h-${id}`, stratum: { pool: "multi", kind: "feature" }, title: `Task ${id}`, doneWhen: "done", kind: "feature", pool: "multi", baseSha: "b", landed: [{ pr: 1, mergeSha: "m", title: "t" }], slicesLanded: 2, packages: [], topDirs: [] });
const CASES = [caseOf("TP-1"), caseOf("TP-2")];

const job = (arm: string, model: string, caseId: string, attempt: number) => ({ arm: { id: arm, model, effort: "high" }, caseId, attempt });
const score = (arm: string, caseId: string, attempt: number, outcome: string, planFile: string) => ({ arm, caseId, attempt, outcome, result: { planFile } });

const JOBS = [job(ANCHOR_ARM, "claude-opus-5-5", "TP-1", 1), job("H-high", "claude-haiku-5-5", "TP-1", 1), job(ANCHOR_ARM, "claude-opus-5-5", "TP-2", 1), job("H-high", "claude-haiku-5-5", "TP-2", 1), job("H-high", "claude-haiku-5-5", "TP-2", 2)];
const SCORES = [score(ANCHOR_ARM, "TP-1", 1, "ok", "plans/s1.md"), score("H-high", "TP-1", 1, "ok", "plans/s2.md"), score(ANCHOR_ARM, "TP-2", 1, "ok", "plans/s3.md"), score("H-high", "TP-2", 1, "infra", "plans/none.md"), score("H-high", "TP-2", 2, "ok", "plans/s4.md")];

/** Answers every criterion with one verdict, quoting the start of plan A as it was shown. */
function answer(question: { texts: Readonly<Record<string, string>> }, verdict: string) {
  const evidence = (question.texts["plan-A"] ?? "").slice(0, 12);
  return { criteria: ["coverage", "landable", "tests", "consistent", "overall"].map((id) => ({ id, verdict, cites: "plan-A", evidence })) };
}

describe("planPairItems", () => {
  it("pairs each non-anchor arm with the anchor, both orders, with a judge neither arm uses", () => {
    const items = planPairItems(storedPlans(SCORES, JOBS, source), CASES, source);

    expect(items.map((entry) => entry.item.key)).toEqual([pairKey("TP-1", "H-high"), pairKey("TP-2", "H-high")]);
    expect(items[0]?.item.questions).toHaveLength(2);
    expect(items[0]?.judges.judge.model).toBe("claude-sonnet-5-5");
    expect(items[1]?.item.questions[0]?.texts["plan-A"]).toContain("south-2-retry");
  });

  it("keeps item keys stable when a resumed run reads rows in another order with new attempts", () => {
    const first = planPairItems(storedPlans(SCORES, JOBS, source), CASES, source).map((entry) => entry.item.key);
    const resumed = planPairItems(storedPlans([...SCORES].reverse(), [...JOBS].reverse(), source), CASES, source).map((entry) => entry.item.key);

    expect(resumed).toEqual(first);
    expect(first).toEqual(["p:TP-1:H-high~O-med", "p:TP-2:H-high~O-med"]);
  });

  it("maps a swapped-order verdict back to the canonical arm", () => {
    const [entry] = planPairItems(storedPlans(SCORES, JOBS, source), CASES, source);
    const swapped = entry?.item.questions[1];
    if (swapped === undefined) throw new Error("no swapped order");

    expect(checkAnswer(swapped, answer(swapped, "A")).outcome).toBe("B");
  });

  it("names no arm or model in the prompt", () => {
    const prompts = planPairItems(storedPlans(SCORES, JOBS, source), CASES, source).flatMap((entry) => entry.item.questions.map(renderPrompt));
    for (const prompt of prompts) for (const leak of ["H-high", "O-med", "claude-", "haiku", "opus"]) expect(prompt).not.toContain(leak);
  });
});

describe("planControls", () => {
  const controls = planControls(storedPlans(SCORES, JOBS, source), CASES, source);
  const byKey = new Map(controls.map((control) => [control.key, control]));

  it("expects the full anchor plan to beat the same plan with half its slices removed", () => {
    const halved = byKey.get("ctl-a:TP-1");
    const texts = halved?.questions[0]?.texts;

    expect(halved?.expected).toBe("A");
    expect(texts?.["plan-A"]).toContain("4. cli");
    expect(texts?.["plan-B"]).toContain("2. wire");
    expect(texts?.["plan-B"]).not.toContain("3. docs");
  });

  it("expects the anchor plan to beat the anchor plan written for a different case", () => {
    const other = byKey.get("ctl-b:TP-1")?.questions[0]?.texts;

    expect(byKey.get("ctl-b:TP-1")?.expected).toBe("A");
    expect(other?.["plan-A"]).toContain("north-1");
    expect(other?.["plan-B"]).toContain("north-2");
    expect(other?.["landed-reference"]).toBe("landed reference for TP-1");
  });

  it("expects a tie between two identical plans", () => {
    const same = byKey.get("ctl-c:TP-2");

    expect(same?.expected).toBe(TIE);
    expect(same?.questions[0]?.texts["plan-A"]).toBe(same?.questions[0]?.texts["plan-B"]);
  });

  it("builds every control in both orders", () => {
    expect([...byKey.keys()].sort()).toEqual(["ctl-a:TP-1", "ctl-a:TP-2", "ctl-b:TP-1", "ctl-b:TP-2", "ctl-c:TP-1", "ctl-c:TP-2"]);
    for (const control of controls) expect(control.questions).toHaveLength(2);
  });
});
