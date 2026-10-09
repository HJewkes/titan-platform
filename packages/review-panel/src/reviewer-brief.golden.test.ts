import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { correctionPrompt, reviewerBrief, type MalformedRefusal } from "./reviewer-brief.js";

// The fixture was rendered by Shepherd's own builders before they moved here; any edit to a brief shows up as a diff against it.
const golden: Record<string, string> = JSON.parse(readFileSync(new URL("./__fixtures__/briefs.golden.json", import.meta.url), "utf8"));
const target = { repo: "octo/demo", pr: 7, head: "0123456789abcdef0123456789abcdef01234567" };
const questions = ["Is   the retry\nbounded?", "Does the cache key include the head?"];
const refusals: MalformedRefusal[] = ["no_block", "multiple_blocks", "bad_verdict", "missing_pr_line", "bad_pr", "missing_head_line", "bad_head", "wrong_target"];

const reviews: [string, string][] = [
  ["standard review", reviewerBrief(target)],
  ["standard review with questions", reviewerBrief({ ...target, questions })],
  ["g10 review", reviewerBrief({ ...target, ownerBrief: true })],
  ["g10 review with questions", reviewerBrief({ ...target, ownerBrief: true, questions })],
  ["re-review after one FIX_FIRST", reviewerBrief({ ...target, fixFirsts: 1 })],
  ["re-review after three FIX_FIRSTs", reviewerBrief({ ...target, fixFirsts: 3 })],
  ["g10 re-review", reviewerBrief({ ...target, fixFirsts: 2, ownerBrief: true, questions })],
];
const corrections: [string, string][] = refusals.flatMap((refusal) => [
  [`correction ${refusal}`, correctionPrompt({ ...target, refusal })] as [string, string],
  [`correction ${refusal} g10`, correctionPrompt({ ...target, refusal, ownerBrief: true })] as [string, string],
]);

describe("rendered briefs against main's output", () => {
  it("covers every golden case", () => {
    expect([...reviews, ...corrections].map(([name]) => name).sort()).toEqual(Object.keys(golden).sort());
  });

  it.each([...reviews, ...corrections])("is byte-identical for %s", (name, rendered) => {
    expect(rendered).toBe(golden[name]);
  });
});
