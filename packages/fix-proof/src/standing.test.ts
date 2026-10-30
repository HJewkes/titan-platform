import { describe, expect, it } from "vitest";
import { formatResultLine, type FixProofResult } from "./result-line.js";
import { endsReview, needsTestsSeat, proofStanding } from "./standing.js";

const HEAD = "a".repeat(40);
const OTHER = "c".repeat(40);
const KILLED = { verdict: "killed" as const, results: [{ spec: "src/a.test.mutations.json", name: "drop the bound", outcome: "killed" as const }], uncovered: [] };

const lineOf = (overrides: Partial<FixProofResult>): string =>
  formatResultLine({
    head: HEAD,
    mergeBase: "b".repeat(40),
    verdict: "vacuous",
    counts: { reproduces: 0, "passes-on-base": 1, "new-api": 0, "fails-on-head": 0, "not-run": 0 },
    notCollected: [],
    deletedTests: [],
    configEdited: false,
    tests: [{ file: "src/a.test.ts", name: "holds", class: "passes-on-base" }],
    truncated: false,
    ...overrides,
  });

const NO_COUNTS = { reproduces: 0, "passes-on-base": 0, "new-api": 0, "fails-on-head": 0, "not-run": 0 };
const standingOf = (overrides: Partial<FixProofResult>, flags: { testOnlyProceed?: true; nonSourceProceed?: true } = {}) =>
  proofStanding({ kind: "result", line: lineOf(overrides), ...flags }, HEAD);

describe("proofStanding", () => {
  it("reads a vacuous line its mutants prove as proved, which neither ends the review nor needs the tests seat (tp#2145)", () => {
    const standing = standingOf({ mutants: KILLED });

    expect(standing).toEqual({ kind: "proved" });
    expect(endsReview(standing)).toBe(false);
    expect(needsTestsSeat(standing)).toBe(false);
  });

  it("reads a vacuous line with a surviving mutant as a NO_REPRO that ends the review", () => {
    const survived = { verdict: "not-killed" as const, results: [{ spec: "src/a.test.mutations.json", name: "drop the bound", outcome: "survived" as const }], uncovered: [] };

    const standing = standingOf({ mutants: survived });

    expect(standing).toMatchObject({ kind: "no-repro", result: { verdict: "vacuous", head: HEAD } });
    expect(endsReview(standing)).toBe(true);
  });

  it("reads an unproved workflow-only CI read at the head as a NO_REPRO carrying the read (cw#247, tp#2325)", () => {
    const read = { kind: "workflow-ci" as const, proved: false, head: HEAD };

    expect(proofStanding(read, HEAD)).toEqual({ kind: "no-repro", result: read });
  });

  it("reads a refused line as unverified, which needs the tests seat", () => {
    const standing = standingOf({ verdict: "refused", counts: NO_COUNTS, tests: [], base: "stacked", defaultBranch: "main" });

    expect(standing).toEqual({ kind: "unverified", why: "refused" });
    expect(needsTestsSeat(standing)).toBe(true);
  });

  it("keeps an unproven line apart: it does not end the review but does need the tests seat", () => {
    const standing = standingOf({ verdict: "unproven", counts: { ...NO_COUNTS, "new-api": 1 } });

    expect(standing).toEqual({ kind: "unproven" });
    expect(endsReview(standing)).toBe(false);
    expect(needsTestsSeat(standing)).toBe(true);
  });

  it("keeps a mutation spec error's text in the detail of an unverified error", () => {
    const error = "mutation spec: mutation drop: src/support.ts is a carried test-support file";

    expect(standingOf({ verdict: "error", counts: NO_COUNTS, tests: [], error })).toEqual({ kind: "unverified", why: "error", detail: error });
  });

  it("names the non-source proceed on a NO_REPRO the caller lets through, which then does not end the review", () => {
    const standing = standingOf({}, { nonSourceProceed: true });

    expect(standing).toMatchObject({ kind: "no-repro", proceeds: "non-source" });
    expect(endsReview(standing)).toBe(false);
  });

  it("reads a line for another head as unread", () => {
    expect(proofStanding({ kind: "result", line: lineOf({ head: OTHER, mutants: KILLED }) }, HEAD)).toMatchObject({ kind: "unverified", why: "unread" });
  });

  it("reads a skipped read as no standing at all", () => {
    expect(proofStanding({ kind: "skipped", reason: "kind feature" }, HEAD)).toEqual({ kind: "none" });
  });
});
