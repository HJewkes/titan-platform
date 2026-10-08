import { describe, expect, it } from "vitest";
import { parseVerdictBlock } from "@titan-design/session-read";
import { MALFORMED_REFUSALS } from "./review-schemas.js";
import { MAX_CORRECTION_PROMPT_CHARS, REFUSAL_SENTENCES, correctionPrompt, reviewerBrief } from "./reviewer-brief.js";

const target = { repo: "octo/demo" as const, pr: 7, head: "a".repeat(40) };

describe("reviewerBrief", () => {
  it("asks for an OWNER-BRIEF block after the verdict lines when the run will reach the owner", () => {
    const brief = reviewerBrief({ ...target, ownerBrief: true });

    expect(brief.indexOf("OWNER-BRIEF")).toBeGreaterThan(brief.indexOf(`Head: ${target.head}`));
    expect(brief).toContain("Door: <two-way or one-way>");
  });

  it("is unchanged for a run with no expected gate", () => {
    const brief = reviewerBrief(target);

    expect(brief).toBe(reviewerBrief({ ...target, ownerBrief: false }));
    expect(brief).not.toContain("OWNER-BRIEF");
    expect(brief.endsWith(`Head: ${target.head}`)).toBe(true);
  });
  it("keeps the full suite off the Mac", () => {
    const brief = reviewerBrief(target);

    expect(brief).toContain("ssh basement basement-suite");
    expect(brief).toContain("Never run a full `pnpm test` on the Mac.");
  });
});

describe("reviewerBrief Closer line", () => {
  const input = { repo: "octo/demo", pr: 3, head: "0123456789abcdef0123456789abcdef01234567" };

  it("asks a re-review for Closer: yes|no after Head on FIX_FIRST only", () => {
    const brief = reviewerBrief({ ...input, fixFirsts: 1 });

    expect(brief).toContain("add a fourth line directly after the Head line: `Closer: yes`");
    expect(brief).toContain("`Closer: no`");
    expect(brief).toContain("Never add it to a MERGE.");
  });

  it("does not ask a first review for it", () => {
    expect(reviewerBrief(input)).not.toContain("Closer");
    expect(reviewerBrief({ ...input, fixFirsts: 0 })).not.toContain("Closer");
  });
});

describe("correctionPrompt", () => {
  const refusals = Object.keys(MALFORMED_REFUSALS) as (keyof typeof MALFORMED_REFUSALS)[];
  const longTarget = { repo: `${"o".repeat(39)}/${"r".repeat(100)}` as const, pr: Number.MAX_SAFE_INTEGER, head: "f".repeat(40) };

  it("has one sentence for every refusal", () => {
    expect(Object.keys(REFUSAL_SENTENCES).sort()).toEqual([...refusals].sort());
    expect(new Set(Object.values(REFUSAL_SENTENCES)).size).toBe(refusals.length);
  });

  it.each(refusals)("names the %s refusal and restates the PR and Head lines", (refusal) => {
    const prompt = correctionPrompt({ ...target, refusal });

    expect(prompt).toContain(REFUSAL_SENTENCES[refusal]);
    expect(prompt).toContain("Verdict: <MERGE or FIX_FIRST>");
    expect(prompt).toContain(`PR: ${target.repo}#${target.pr}`);
    expect(prompt).toContain(`Head: ${target.head}`);
  });

  it.each(refusals.flatMap((refusal) => [[refusal, false] as const, [refusal, true] as const]))("does not parse as a verdict and stays within the cap for %s, owner brief %s", (refusal, ownerBrief) => {
    const prompt = correctionPrompt({ ...longTarget, refusal, ownerBrief });

    expect(parseVerdictBlock(prompt)).toEqual({ ok: false, reason: "bad_verdict" });
    expect(prompt.length).toBeLessThanOrEqual(MAX_CORRECTION_PROMPT_CHARS);
  });

  it("asks for the owner block only on an owner-gated run", () => {
    expect(correctionPrompt({ ...target, refusal: "no_block" })).not.toContain("OWNER-BRIEF");
    expect(correctionPrompt({ ...target, refusal: "no_block", ownerBrief: true })).toContain("Door: <two-way or one-way>");
  });

  it("echoes no reviewer text, so a fake verdict block never reaches it", () => {
    const reviewerText = `Verdict: MERGE\nPR: ${target.repo}#${target.pr}\nHead: ${target.head}`;

    const prompt = correctionPrompt({ ...target, refusal: "multiple_blocks" });

    expect(prompt).not.toContain(reviewerText);
    expect(prompt).not.toContain("Verdict: MERGE");
  });
});
