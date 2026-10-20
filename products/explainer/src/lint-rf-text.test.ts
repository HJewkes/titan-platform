import { describe, expect, it } from "vitest";
import { type RfTextProfile, rfTextLint } from "./lint-flow.js";
import { RF_BANNED, rfSentenceIssues, spokenNumbers } from "./lint-text.js";
import { type RfIssue, readRfScript } from "./rf-script.js";
import { applyEdits, fixtureBytes, type Lint, loadLint, loadSeededProvenance, loadSeeds, readGolden } from "./rf-goldens.test-helpers.js";

// The checks L1 ports. The goldens also hold the L2-L4 checks (budgets, map, recipe, origin...), which this slice
// leaves to those ports, so the differential compares only these.
const L1_CHECKS = new Set(["Q-W1", "Q-V9", "Q-V1/V4/V7", "Q-F9", "numbers", "Q-F11", "rule3", "rule5", "chips"]);

// Each frozen script's build_script.py carried its own numbers rule and outro cap; these are those copies.
const PROFILES: Record<string, RfTextProfile> = {
  "redesign-explainer-v4": {
    allowedNumbers: [51.5, 47, 270, 81.7, 5, 2, 302, 482, 18],
    allowedPhrases: /\bthirty to thirty-five percent\b|\b30\s?[–-]\s?35\s?%/,
    outroMaxWords: 8,
  },
  "review-addendum-v5": { allowedNumbers: [8, 6, 520, 999, 13], outroMaxWords: 25, ownerRules: true },
};

const baseDoc = (base: string): unknown => {
  const fixture = loadSeededProvenance().bases[base]?.fixture ?? "";
  return JSON.parse(fixtureBytes(fixture).toString("utf8"));
};

const seededDoc = (variant: string): { base: string; doc: unknown } => {
  const seed = loadSeeds()[variant];
  if (!seed) throw new Error(`${variant} missing from seeds.json`);
  return { base: seed.base, doc: applyEdits(baseDoc(seed.base), seed.edits) };
};

const sorted = (issues: readonly Lint["issues"][number][]): string[] => issues.map((issue) => JSON.stringify(issue)).sort();

const l1Golden = (lint: Lint): string[] => sorted(lint.issues.filter((issue) => L1_CHECKS.has(issue.check)));

const portIssues = (base: string, doc: unknown, profile: Partial<RfTextProfile> = {}): string[] => {
  const issues: RfIssue[] = rfTextLint(readRfScript(doc), { ...PROFILES[base]!, ...profile });
  return sorted(issues);
};

const frozenLint = (name: string): Lint => JSON.parse(readGolden(`${name}/lint.json`).toString("utf8")) as Lint;

describe("RF text lints against the A2 goldens", () => {
  it.each(Object.keys(PROFILES))("finds no issue on the frozen %s script, as the Python did", (name) => {
    expect(portIssues(name, baseDoc(name))).toEqual(l1Golden(frozenLint(name)));
  });

  it.each(Object.keys(loadSeeds()))("matches the Python's L1 issues on seeded variant %s", (variant) => {
    const { base, doc } = seededDoc(variant);

    expect(portIssues(base, doc)).toEqual(l1Golden(loadLint(variant)));
  });

  it("covers every L1 check but the Q-F9 list warning with at least one seeded true positive", () => {
    const seen = new Set(Object.keys(loadSeeds()).flatMap((variant) => loadLint(variant).issues.map((issue) => issue.check)));

    expect([...L1_CHECKS].filter((check) => !seen.has(check))).toEqual(["Q-F9"]);
  });

  it("fails the differential when the banned-phrase regex loses its word boundary", () => {
    const { base, doc } = seededDoc("v4-banned-simply");
    const unbounded = RF_BANNED.map((pattern) => pattern.replaceAll("\\b", ""));

    expect(portIssues(base, doc, { banned: unbounded })).not.toEqual(l1Golden(loadLint("v4-banned-simply")));
  });
});

describe("RF text lints on synthetic lines", () => {
  it("reads a banned word only as a whole word", () => {
    const flagged = (line: string) => rfSentenceIssues("b1", line).map((issue) => issue.check);

    expect(flagged("The fix is uneasy and the setup is easygoing.")).toEqual([]);
    expect(flagged("The fix is easy.")).toEqual(["Q-V1/V4/V7"]);
  });

  it("counts spoken quantities across scales, halves and hyphens, but not identifiers", () => {
    expect(spokenNumbers("Three hundred and two of them, fifty-one and a half each, F12 and two more.")).toEqual([302, 51.5, 2]);
  });

  it("drops a stated range before counting", () => {
    expect(spokenNumbers("Thirty to thirty-five percent merge up.", /\bthirty to thirty-five percent\b/)).toEqual([]);
  });

  it("warns on a sentence with five commas as a possible spoken list", () => {
    const issues = rfSentenceIssues("b1", "One, two, three, four, five, and six.");

    expect(issues).toEqual([{ beat: "b1", check: "Q-F9", severity: "warn", message: "possible spoken list over 5 items: One, two, three, four, five, and six." }]);
  });
});
