import { describe, expect, it } from "vitest";
import { diag } from "./diagnostics.js";
import { ExplainerFactSchema, FACT_KINDS, FACT_SOURCES, ReviewBundleSchema } from "./schemas.js";

const SHA = "2ddf3eb6c13d97b1d04a932c21de9a92029adaf9";

const bundle = (fields: Record<string, unknown> = {}) => ({
  schema: "review-bundle/v1",
  repo: { url: "https://github.com/devdotfast/whiteboard", sha: SHA, clone: "/tmp/whiteboard" },
  label: "final",
  coverage: { unread: 0, line: "repo=whiteboard unread=0" },
  licenses: [{ prefix: "apps/review-desktop/", license: "MIT" }],
  files_sha256: { "SUMMARY.md": "a".repeat(64) },
  counts: { topic: 2, claim: 1 },
  ...fields,
});

const fact = (fields: Record<string, unknown> = {}) => ({
  id: "WBT-WF-04",
  source: "topic",
  kind: "feature",
  text: "Reviews pin to a commit.",
  evidence: [{ path: "packages/review/src/source.ts", lineStart: 40, lineEnd: 52 }],
  tier: "workflow",
  verified: "yes",
  license_safe: true,
  ...fields,
});

describe("ReviewBundleSchema", () => {
  it("accepts a v1 bundle", () => {
    expect(ReviewBundleSchema.safeParse(bundle()).success).toBe(true);
  });

  it("rejects a bundle tagged with another schema version", () => {
    expect(ReviewBundleSchema.safeParse(bundle({ schema: "review-bundle/v2" })).success).toBe(false);
  });

  it("rejects a pin that is not a full sha", () => {
    const repo = { url: "https://github.com/devdotfast/whiteboard", sha: "2ddf3eb6", clone: "/tmp/whiteboard" };

    expect(ReviewBundleSchema.safeParse(bundle({ repo })).success).toBe(false);
  });

  it("rejects a count keyed by an unknown source", () => {
    expect(ReviewBundleSchema.safeParse(bundle({ counts: { topics: 2 } })).success).toBe(false);
  });
});

describe("ExplainerFactSchema", () => {
  it("accepts every source and every kind, including pain and the tour kinds", () => {
    const facts = [
      ...FACT_SOURCES.map((source) => fact({ source })),
      ...FACT_KINDS.map((kind) => fact({ kind, source: "summary" })),
    ];

    expect(facts.every((candidate) => ExplainerFactSchema.safeParse(candidate).success)).toBe(true);
    expect(FACT_KINDS).toEqual(
      expect.arrayContaining(["what-it-is", "entry-point", "read-first", "should-not", "integration-rec", "capability", "pain"]),
    );
  });

  it("accepts file-level evidence with no lines", () => {
    expect(ExplainerFactSchema.safeParse(fact({ evidence: [{ path: "README.md" }] })).success).toBe(true);
  });

  it("rejects a span with lineStart but no lineEnd", () => {
    expect(ExplainerFactSchema.safeParse(fact({ evidence: [{ path: "a.ts", lineStart: 3 }] })).success).toBe(false);
  });

  it("rejects a span whose end is before its start", () => {
    const evidence = [{ path: "a.ts", lineStart: 9, lineEnd: 4 }];

    expect(ExplainerFactSchema.safeParse(fact({ evidence })).success).toBe(false);
  });
});

describe("diag", () => {
  it("takes severity and fixes from the code table", () => {
    expect(diag("E-PIN", "clone HEAD is off the pin")).toEqual({
      code: "E-PIN",
      message: "clone HEAD is off the pin",
      severity: "error",
      supportedFixes: ["checkout-pin"],
    });
    expect(diag("W-BAD-ROW", "short row", "ledger.tsv:12")).toEqual({
      code: "W-BAD-ROW",
      message: "short row",
      severity: "warning",
      selector: "ledger.tsv:12",
    });
  });
});
