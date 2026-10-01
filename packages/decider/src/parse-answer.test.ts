import { describe, expect, it } from "vitest";
import { answerFor, parseAnswerText, recommendedOption } from "./parse-answer.js";

describe("parseAnswerText", () => {
  it("keeps quotes inside an answer that the harness did not use as separators", () => {
    const parsed = parseAnswerText('The user answered: "Name?"="Call it "beta" for now", "Ship?"="Yes". Done.');

    expect(Object.fromEntries(parsed.answers)).toEqual({ "Name?": 'Call it "beta" for now', "Ship?": "Yes" });
  });

  it("reads the structured JSON form", () => {
    expect(parseAnswerText('{"answers":{"Ship?":"Yes"}}').answers.get("Ship?")).toBe("Yes");
  });

  it("marks a declined question rejected", () => {
    expect(parseAnswerText("The user doesn't want to proceed with this tool use.").rejected).toBe(true);
  });
});

describe("answerFor", () => {
  it("falls back to a 40-character prefix when the harness truncated the question", () => {
    const question = "Should the widget refresh move to the queue before the March import?";
    const answers = new Map([[question.slice(0, 45), "Yes"]]);

    expect(answerFor(answers, question)).toBe("Yes");
  });
});

describe("recommendedOption", () => {
  it("finds a marker anywhere in the label", () => {
    expect(recommendedOption(["Hold", "Recommended: Ship it"])).toBe("Recommended: Ship it");
  });

  it("skips an option the asker advised against when it comes before the recommended one", () => {
    const options = ["Force push (not recommended)", "Rebase onto main (Recommended)"];

    expect(recommendedOption(options)).toBe("Rebase onto main (Recommended)");
  });

  it("finds none when a label's own words start with recommend", () => {
    expect(recommendedOption(["Recommend the vendor to the team", "Hold"])).toBeNull();
  });
});
