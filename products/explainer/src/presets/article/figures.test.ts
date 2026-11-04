import { describe, expect, it } from "vitest";
import { gatherDemo as gather } from "../../article-fixtures.test-helpers.js";

describe("gatherArticle facts", () => {
  it("extracts a numeric-x table as a line figure and a category table as a bar figure, ready to re-plot", async () => {
    const { facts } = await gather();
    const line = facts.find((fact) => fact.id === "figure/figure-1");
    const bar = facts.find((fact) => fact.id === "figure/table-2");

    expect(line?.figure).toEqual({
      kind: "line",
      x: "Pass rate",
      y: "Mean rounds per change by one-round pass rate",
      series: [
        { id: "full-re-read", label: "Full re-read", points: [{ x: 0.65, y: 2.08 }, { x: 0.7, y: 1.84 }, { x: 0.78, y: 1.55 }] },
        { id: "diff-only", label: "Diff only", points: [{ x: 0.65, y: 1.71 }, { x: 0.7, y: 1.52 }, { x: 0.78, y: 1.32 }] },
      ],
    });
    expect(line?.source.ref).toBe("article.md:14");
    expect(bar?.figure).toMatchObject({ kind: "bar", categories: ["Low", "Medium", "High"], series: [{ points: [{ x: 1, y: 640 }, { x: 2, y: 410 }, { x: 3, y: 150 }] }] });
  });

  it("notes a figure held only as an image and a table of text, and makes neither a figure", async () => {
    const { notes } = await gather();

    expect(notes.map(({ code, id }) => [code, id])).toEqual([
      ["W-FIGURE-NO-DATA", "figure-2"],
      ["W-TABLE-TEXT", "table-1"],
    ]);
  });
});
