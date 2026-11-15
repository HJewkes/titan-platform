import { describe, expect, it } from "vitest";
import { correctionPrompt, MAX_CORRECTION_PROMPT_CHARS } from "./reviewer-brief.js";

const ownerGatedTarget = { repo: "octo-org/demo-service" as const, pr: 12_345, head: "f".repeat(40) };
const lead = "**Authority gate.** No console tap reaches the write path.";
const reword = "Reword each line below so it does not start with Authority:";

describe("correctionPrompt for an authority_missing refusal", () => {
  it("an authority_missing correction with a quote shows the quote and the reword line within 1700 chars", () => {
    const prompt = correctionPrompt({ ...ownerGatedTarget, refusal: "authority_missing", ownerBrief: true, quotes: [lead] });

    expect(prompt).toContain(`${reword}\n> ${lead}`);
    expect(prompt.length).toBeLessThanOrEqual(MAX_CORRECTION_PROMPT_CHARS);
  });

  it("heads the quoted lines without the CI-policy reword rule", () => {
    const prompt = correctionPrompt({ ...ownerGatedTarget, refusal: "authority_missing", quotes: [lead] });

    expect(prompt).not.toContain('does not start with "CI policy"');
  });

  it("names a line starting with Authority as a cause of the refusal and asks for one Authority line", () => {
    const prompt = correctionPrompt({ ...ownerGatedTarget, refusal: "authority_missing" });

    expect(prompt).toContain("or another line started with the word Authority");
    expect(prompt).toContain("Above the verdict lines keep one `Authority:` line: unchanged, tightened or widened.");
  });
});
