import { describe, expect, it } from "vitest";
import { initiativeForCwd, isExcluded, type ExclusionSubject } from "./exclusion.js";
import { POLICY, v1Row } from "./fixtures.js";
import { LedgerRowSchema } from "./ledger.js";

function subject(overrides: Partial<ExclusionSubject> = {}): ExclusionSubject {
  return {
    initiative: "widgets",
    cwd: "/home/example/projects/widgets",
    header: "Scheduler",
    question: "How should the widget refresh run?",
    options: [{ label: "Use a queue" }],
    answer: "Use a queue",
    ...overrides,
  };
}

describe("isExcluded", () => {
  it("lets an ordinary claimed row through", () => {
    expect(isExcluded(subject(), POLICY)).toEqual({
      excluded: false,
      initiative: "widgets",
      unclaimed: false,
    });
  });

  it("excludes a row in a human-only initiative", () => {
    expect(isExcluded(subject({ initiative: "garden-diary", cwd: null }), POLICY)).toEqual({
      excluded: true,
      reason: "human-only-initiative",
    });
  });

  it("excludes a row when one of two mentioned initiatives is human-only", () => {
    const verdict = isExcluded(subject({ mentionedInitiatives: ["widgets", "garden-diary"] }), POLICY);

    expect(verdict).toEqual({ excluded: true, reason: "human-only-initiative" });
  });

  it("changes nothing when no mentioned initiative is human-only", () => {
    const verdict = isExcluded(subject({ mentionedInitiatives: ["widgets", "gadgets"] }), POLICY);

    expect(verdict).toEqual({ excluded: false, initiative: "widgets", unclaimed: false });
  });

  it("changes nothing when the mention list is absent", () => {
    expect(isExcluded(subject({ mentionedInitiatives: undefined }), POLICY)).toEqual(isExcluded(subject(), POLICY));
  });

  it("excludes a row whose cwd sits under a human-only project directory", () => {
    const verdict = isExcluded(subject({ initiative: null, cwd: "/home/example/projects/garden/beds" }), POLICY);

    expect(verdict).toEqual({ excluded: true, reason: "human-only-cwd" });
  });

  it("excludes a row that names a listed person, whatever the case", () => {
    const verdict = isExcluded(subject({ answer: "Ask zorblat first" }), POLICY);

    expect(verdict).toEqual({ excluded: true, reason: "personal-data" });
  });

  it("matches a string pattern only as a whole word", () => {
    expect(isExcluded(subject({ question: "Rename Zorblatter?" }), POLICY).excluded).toBe(false);
  });

  it("matches a string pattern that starts with @", () => {
    const policy = { ...POLICY, personalDataPatterns: ["@zorblat"] };

    expect(isExcluded(subject({ answer: "ping @zorblat" }), policy).excluded).toBe(true);
  });

  it("matches a string pattern that starts with +", () => {
    const policy = { ...POLICY, personalDataPatterns: ["+44 7700 900123"] };

    expect(isExcluded(subject({ answer: "call +44 7700 900123" }), policy).excluded).toBe(true);
  });

  it("does not match an edge-punctuated pattern inside a longer word", () => {
    const policy = { ...POLICY, personalDataPatterns: ["@zorblat"] };

    expect(isExcluded(subject({ answer: "mail me@zorblatter" }), policy).excluded).toBe(false);
  });

  it("checks option labels against regex patterns", () => {
    const verdict = isExcluded(subject({ options: [{ label: "Attach the payslip" }] }), POLICY);

    expect(verdict).toEqual({ excluded: true, reason: "personal-data" });
  });

  it("checks option descriptions for personal data", () => {
    const options = [{ label: "Attach it", description: "Send the payslip along" }];

    expect(isExcluded(subject({ options }), POLICY)).toEqual({ excluded: true, reason: "personal-data" });
  });

  it("resolves a missing initiative from the cwd mapping", () => {
    const verdict = isExcluded(subject({ initiative: null }), POLICY);

    expect(verdict).toEqual({ excluded: false, initiative: "widgets", unclaimed: false });
  });

  it("writes an unresolved-cwd row but flags it unclaimed", () => {
    const verdict = isExcluded(subject({ initiative: null, cwd: "/srv/scratch" }), POLICY);
    const unclaimed = !verdict.excluded && verdict.unclaimed;
    const row = LedgerRowSchema.parse(v1Row({ initiative: null, unclaimed }));

    expect(verdict).toEqual({ excluded: false, initiative: null, unclaimed: true });
    expect(row.unclaimed).toBe(true);
  });
});

describe("initiativeForCwd", () => {
  it("prefers the deepest matching project directory", () => {
    expect(initiativeForCwd("/home/example/projects/widgets/src", POLICY)).toBe("widgets");
  });

  it("does not treat a sibling directory with a shared prefix as nested", () => {
    expect(initiativeForCwd("/home/example/projects/gardening", POLICY)).toBe("workspace");
  });
});
