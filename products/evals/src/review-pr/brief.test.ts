import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { reviewerBrief, type ReviewerBriefInput } from "@titan-design/review-panel";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../spec/index.js";
import { validateSpec } from "../validate.js";
import { TRIAL_TEST_RULE, bundleLines, reviewPrBrief } from "./brief.js";

const UNIT_ROOT = fileURLToPath(new URL("../../units/review-pr/", import.meta.url));
const readUnitFile = (path: string) => readFile(`${UNIT_ROOT}${path}`);
const readJson = (path: string): unknown => JSON.parse(readFileSync(`${UNIT_ROOT}${path}`, "utf8"));

const HEAD = "a".repeat(40);
const BUNDLE = "/private/evals/bundles/case-1";
const PLAIN: ReviewerBriefInput = { repo: "owner/repo", pr: 7, head: HEAD, checkoutRoot: "/reviews" };
const RE_REVIEW_TO_OWNER: ReviewerBriefInput = { ...PLAIN, fixFirsts: 2, ownerBrief: true, questions: ["Is the cache bounded?"] };

/** The live brief with its checkout block cut out: the lines between the lead line and the next blank line. */
function withoutBlock(brief: string, block: readonly string[]): string[] {
  const lines = brief.split("\n");
  const at = lines.findIndex((line) => line === block[0]);
  expect(at).toBeGreaterThan(0);
  return [...lines.slice(0, at), ...lines.slice(at + block.length)];
}

describe("reviewPrBrief", () => {
  it.each([
    ["plain", PLAIN],
    ["re-review to owner", RE_REVIEW_TO_OWNER],
  ] as const)("keeps every line but the checkout lines byte-identical to reviewerBrief with the trial rule (%s)", (_name, input) => {
    const live = reviewerBrief({ ...input, testRule: TRIAL_TEST_RULE });
    const liveBlock = live.split("\n").filter((line) => line.startsWith("  ") || line.startsWith("If you need the base"));

    const trial = reviewPrBrief(input, BUNDLE);

    expect(liveBlock).toHaveLength(4);
    expect(withoutBlock(trial, bundleLines(BUNDLE))).toEqual(withoutBlock(live, liveBlock));
  });

  it("names no gh command and no git fetch, and points at the bundle paths instead", () => {
    const trial = reviewPrBrief(PLAIN, `${BUNDLE}/`);

    expect(trial).not.toMatch(/\bgh pr\b|git fetch|git archive/);
    expect(trial).toContain(`"${BUNDLE}/head"`);
    expect(trial).toContain(`"${BUNDLE}/diff.patch"`);
    expect(trial).toContain(`"${BUNDLE}/base"`);
  });

  it("tells the trial reviewer there is no CI to read, so a missing check never decides its verdict", () => {
    const trial = reviewPrBrief(PLAIN, BUNDLE);

    expect(trial).toContain(TRIAL_TEST_RULE);
    expect(trial).not.toMatch(/check-runs|\bgh api\b|basement-suite/);
  });
});

describe("the shipped review-pr unit", () => {
  it.each(["unit.json", "variants/live-brief.json"])("validates %s with a current prompt digest", async (file) => {
    const result = await validateSpec(readJson(file), readUnitFile);

    expect(result.stalePrompts).toBe(false);
  });

  it("keeps the trial read-only: no Write, Edit, git push or gh", () => {
    const variant = parseSpec(readJson("variants/live-brief.json"));
    const step = variant.schema === "titan.variant/v1" ? variant.steps.review : undefined;

    expect(step?.kind).toBe("agent");
    expect(step && "disallowedTools" in step ? step.disallowedTools : []).toEqual(expect.arrayContaining(["Write", "Edit", "Bash(git push:*)", "Bash(gh:*)"]));
  });
});
