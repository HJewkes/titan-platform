import { describe, expect, it } from "vitest";
import { digestFacts } from "./digest-facts.js";
import { ExplainerFactSchema } from "./schemas.js";

const DIGEST = JSON.stringify({
  meta: { bundle: "WB-W1-001" },
  summary: "Root-wave bundle: two plugin marketplace manifests plus the desktop shell.",
  findings: [],
  files: [
    { path: ".agents/plugins/marketplace.json", purpose_one_line: "Codex plugin marketplace manifest.", notable: true },
    { path: "apps/review-desktop/code-oss/src/vs/review/browser/workbench.ts", purpose_one_line: "Fixed-grid workbench." },
    { path: "apps/review-desktop/README.md" },
  ],
});

describe("digestFacts", () => {
  it("yields one schema-valid shape fact with the summary as text and purposes as captions", () => {
    const { facts, diagnostics } = digestFacts("WB-W1-001", DIGEST);

    expect(diagnostics).toEqual([]);
    const fact = ExplainerFactSchema.parse(facts[0]);
    expect(fact).toMatchObject({
      id: "D-WB-W1-001",
      source: "digest",
      kind: "shape",
      text: "Root-wave bundle: two plugin marketplace manifests plus the desktop shell.",
      verified: "yes",
      captions: ["Codex plugin marketplace manifest.", "Fixed-grid workbench."],
    });
  });

  it("cites each listed file at file level, never with invented lines", () => {
    const { facts } = digestFacts("WB-W1-001", DIGEST);

    expect(facts[0]!.evidence).toEqual([
      { path: ".agents/plugins/marketplace.json" },
      { path: "apps/review-desktop/code-oss/src/vs/review/browser/workbench.ts" },
      { path: "apps/review-desktop/README.md" },
    ]);
  });

  it("is license-unsafe when any listed file fails the check", () => {
    const { facts } = digestFacts("WB-W1-001", DIGEST, { isLicenseSafe: (path) => !path.includes("code-oss") });

    expect(facts[0]!.license_safe).toBe(false);
  });

  it("skips a digest with no summary and warns W-BAD-ROW naming it", () => {
    const { facts, diagnostics } = digestFacts("WB-W3-001", JSON.stringify({ files: [] }));

    expect(facts).toEqual([]);
    expect(diagnostics).toMatchObject([{ code: "W-BAD-ROW", severity: "warning", selector: "digests/WB-W3-001.json" }]);
  });

  it("skips a digest that is not JSON and warns W-BAD-ROW", () => {
    expect(digestFacts("WB-W3-002", "{not json").diagnostics.map((d) => d.code)).toEqual(["W-BAD-ROW"]);
  });
});
