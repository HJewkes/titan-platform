import { describe, expect, it } from "vitest";
import { prioritizedTopics, summaryRecommendations } from "./review-summary.js";

const summary = [
  "# demo (example/demo): review summary",
  "",
  "## Top findings (P1 and P2)",
  "- **A9. Not a recommendation** (a finding bullet)",
  "",
  "## Integration recommendations (would-be tasks; none filed, per the owner)",
  "",
  "**Adopt now**",
  "- **A1. Parse widgets at ingest** (DMO-CORE-01). Land in `packages/widget`.",
  "  - a nested bullet is part of A1",
  "- **A2: Cache widget renders** (DMO-CORE-02).",
  "",
  "### Ideas",
  "- an unlabelled idea",
  "```",
  "- a bullet inside a fence",
  "## a heading inside a fence",
  "```",
  "",
  "## What we should not do",
  "- **A3. Not a recommendation either**",
].join("\n");

describe("summaryRecommendations", () => {
  it("lists only the top-level bullets of the recommendations section", () => {
    expect(summaryRecommendations(summary)).toEqual([
      { id: "A1", source: "recommendation", line: 9 },
      { id: "A2", source: "recommendation", line: 11 },
      { id: "R3", source: "recommendation", line: 14 },
    ]);
  });

  it("names a numbered list's items by ordinal under a plain Recommendations heading", () => {
    const numbered = "## Recommendations (none filed, per the brief)\n\n1. first\n2. second\n\n## Next";
    expect(summaryRecommendations(numbered).map((item) => item.id)).toEqual(["R1", "R2"]);
  });

  it("refuses a summary with no recommendations heading rather than passing it empty", () => {
    expect(() => summaryRecommendations("# demo\n\n## Top findings\n- one")).toThrow(/no Integration recommendations/);
  });
});

describe("prioritizedTopics", () => {
  it("keeps the P1 and P2 topics with their line in the file", () => {
    const tsv = [
      "topic_id\ttier\tpriority",
      "DMO-CORE-01\tcore\tP1",
      "DMO-CORE-02\tcore\tP3",
      "",
      "DMO-UI-01\tui\tP2",
    ].join("\n");
    expect(prioritizedTopics(tsv)).toEqual([
      { id: "DMO-CORE-01", source: "topic", line: 2 },
      { id: "DMO-UI-01", source: "topic", line: 5 },
    ]);
  });

  it("refuses a topics file without a priority column", () => {
    expect(() => prioritizedTopics("topic_id\ttier\nDMO-CORE-01\tcore")).toThrow(/header lacks priority/);
  });
});
