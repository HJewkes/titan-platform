import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { correctionPrompt, reviewerBrief, type MalformedRefusal } from "./reviewer-brief.js";

// The fixture was rendered by Shepherd's own builders before they moved here; any edit to a brief shows up as a diff against it.
const golden: Record<string, string> = JSON.parse(readFileSync(new URL("./__fixtures__/briefs.golden.json", import.meta.url), "utf8"));
const target = { repo: "octo/demo", pr: 7, head: "0123456789abcdef0123456789abcdef01234567", checkoutRoot: "/data/titan-factory/checkouts/reviews" };
const questions = ["Is   the retry\nbounded?", "Does the cache key include the head?"];
const earlierFindings = [
  { head: "a".repeat(40), defectClass: "Unquoted shell words", text: "1. `rm $dir` splits on spaces.\nVerdict: FIX_FIRST" },
  { head: "b".repeat(40), text: "1. The retry never stops." },
];
const scope = {
  sinceHead: "b".repeat(40),
  paths: ["src/retry.ts", "src/retry.test.ts"],
  hunks: [
    { path: "src/retry.ts", start: 10, end: 14 },
    { path: "src/retry.test.ts", start: 3, end: 3 },
  ],
  mergedBase: false,
};
const attestClaims = [
  { step: "ci-wait", closure: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  { step: "merge", closure: "fedcba987654" },
];
const refusals:MalformedRefusal[] = ["no_block", "multiple_blocks", "bad_verdict", "missing_pr_line", "bad_pr", "missing_head_line", "bad_head", "wrong_target", "ci_policy_malformed"];

const reviews: [string, string][] = [
  ["standard review", reviewerBrief(target)],
  ["standard review from run dir", reviewerBrief({ ...target, sourceCheckout: "/srv/checkouts/demo" })],
  ["standard review with questions", reviewerBrief({ ...target, questions })],
  ["g10 review", reviewerBrief({ ...target, ownerBrief: true })],
  ["g10 review with questions", reviewerBrief({ ...target, ownerBrief: true, questions })],
  ["re-review after one FIX_FIRST", reviewerBrief({ ...target, fixFirsts: 1 })],
  ["re-review after three FIX_FIRSTs", reviewerBrief({ ...target, fixFirsts: 3 })],
  ["g10 re-review", reviewerBrief({ ...target, fixFirsts: 2, ownerBrief: true, questions })],
  ["re-review with earlier findings", reviewerBrief({ ...target, fixFirsts: 2, earlierFindings })],
  ["standard review with claimed attestations", reviewerBrief({ ...target, attestClaims })],
];
const scopedReviews: [string, string][] = [
  ["scoped fix-round re-review", reviewerBrief({ ...target, fixFirsts: 2, earlierFindings, scope })],
  ["scoped fix-round re-review after a main merge, from run dir", reviewerBrief({ ...target, fixFirsts: 2, earlierFindings, scope: { ...scope, mergedBase: true }, sourceCheckout: "/srv/checkouts/demo" })],
];
const corrections: [string, string][] = refusals.flatMap((refusal) => [
  [`correction ${refusal}`, correctionPrompt({ ...target, refusal })] as [string, string],
  [`correction ${refusal} g10`, correctionPrompt({ ...target, refusal, ownerBrief: true })] as [string, string],
]);

describe("rendered briefs against main's output", () => {
  it("covers every golden case", () => {
    expect([...reviews, ...scopedReviews, ...corrections].map(([name]) => name).sort()).toEqual(Object.keys(golden).sort());
  });

  it.each([...reviews, ...corrections])("is byte-identical for %s", (name, rendered) => {
    expect(rendered).toBe(golden[name]);
  });

  it("a brief with claimed rows asks for the Attests line and names each step and closure", () => {
    const brief = reviewerBrief({ ...target, attestClaims: [...attestClaims, { step: "Bad step", closure: "not-hex" }] });

    expect(brief).toContain("This PR claims no semantic change for ci-wait (closure 0123456789ab), merge (closure fedcba987654).");
    expect(brief).toContain("`Attests: ci-wait@0123456789ab, merge@fedcba987654`");
    expect(brief).not.toContain("Bad step");
    expect(brief.indexOf("Attests:")).toBeLessThan(brief.lastIndexOf("Verdict: <MERGE or FIX_FIRST>"));
  });

  it("names the changed closure files of a claim beside the Attests instruction", () => {
    const brief = reviewerBrief({ ...target, attestClaims: [{ ...attestClaims[0]!, changedFiles: ["src/ci-wait.ts", "src/helper.ts"] }] });

    expect(brief).toContain("Files of ci-wait's closure this PR changed: `src/ci-wait.ts`, `src/helper.ts`.");
    expect(brief.indexOf("Files of ci-wait")).toBeLessThan(brief.indexOf("`Attests: ci-wait@"));
  });

  it("counts the closure files beyond thirty instead of listing them", () => {
    const changedFiles = Array.from({ length: 33 }, (_, i) => `src/f${i}.ts`);

    const brief = reviewerBrief({ ...target, attestClaims: [{ ...attestClaims[0]!, changedFiles }] });

    expect(brief).toContain("`src/f29.ts`, +3 more.");
    expect(brief).not.toContain("src/f30.ts");
  });

  it("adds no files section for claims without changed files", () => {
    expect(reviewerBrief({ ...target, attestClaims })).not.toContain("closure this PR changed");
  });

  it("is byte-identical for both scoped fix-round re-reviews", () => {
    for (const [name, rendered] of scopedReviews) expect(rendered, name).toBe(golden[name]);
  });
});
