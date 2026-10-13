import { describe, expect, it } from "vitest";
import { checkDispositions, parseDispositions } from "./dispositions.js";
import { summaryRecommendations } from "./review-summary.js";

const summary = [
  "## Integration recommendations (would-be tasks; none filed, per the owner)",
  "- **A1. Parse widgets at ingest**",
  "- **A2. Cache widget renders**",
  "- **B1. Lens list per widget**",
].join("\n");

const tsv = (...rows: string[]) => ["rec_id\tsummary_line\tdisposition\tref", ...rows].join("\n");

describe("checkDispositions", () => {
  it("passes when every recommendation has a row", () => {
    const rows = parseDispositions(
      tsv("A1\tParse widgets\ttask\tTP-1", "A2\tCache renders\tdup\tTP-2", "B1\tLens list\tdrop\tno second consumer"),
    );
    expect(checkDispositions(summaryRecommendations(summary), rows)).toEqual({
      ok: true,
      missing: [],
      unknown: [],
      duplicated: [],
    });
  });

  it("fails on three recommendations and two rows, naming the third", () => {
    const rows = parseDispositions(tsv("A1\tParse widgets\ttask\tTP-1", "A2\tCache renders\tfold\tTP-2"));
    const check = checkDispositions(summaryRecommendations(summary), rows);
    expect(check.ok).toBe(false);
    expect(check.missing.map((item) => item.id)).toEqual(["B1"]);
  });

  it("fails when the row count matches but one item is named twice", () => {
    const rows = parseDispositions(
      tsv("A1\tParse widgets\ttask\tTP-1", "A2\tCache renders\ttask\tTP-2", "A2\tCache renders\tdrop\tlater"),
    );
    const check = checkDispositions(summaryRecommendations(summary), rows);
    expect(check).toMatchObject({ ok: false, duplicated: ["A2"] });
    expect(check.missing.map((item) => item.id)).toEqual(["B1"]);
  });

  it("fails on a row whose id names no recommendation", () => {
    const rows = parseDispositions(
      tsv("A1\tx\ttask\tTP-1", "A2\tx\ttask\tTP-2", "B1\tx\ttask\tTP-3", "B9\tx\tdrop\ttypo"),
    );
    expect(checkDispositions(summaryRecommendations(summary), rows)).toMatchObject({ ok: false, unknown: ["B9"] });
  });
});

describe("parseDispositions", () => {
  it("accepts pending-owner with a reason when the brief filed nothing", () => {
    const rows = parseDispositions(tsv("A1\tParse widgets\tpending-owner\tbrief says none filed"));
    expect(rows).toEqual([
      { rec_id: "A1", summary_line: "Parse widgets", disposition: "pending-owner", ref: "brief says none filed" },
    ]);
  });

  it.each(["task", "dup", "fold"])("refuses a %s row whose ref is not a task id", (kind) => {
    expect(() => parseDispositions(tsv(`A1\tParse widgets\t${kind}\tsoon`))).toThrow(/dispositions.tsv:2: .*task id/);
  });

  it("refuses a drop row with no reason", () => {
    expect(() => parseDispositions(tsv("A1\tParse widgets\tdrop\t"))).toThrow(/ref is empty/);
  });

  it("refuses an unknown disposition", () => {
    expect(() => parseDispositions(tsv("A1\tParse widgets\tmaybe\tTP-1"))).toThrow(/dispositions.tsv:2/);
  });

  it("refuses a file missing a column", () => {
    expect(() => parseDispositions("rec_id\tdisposition\tref\nA1\ttask\tTP-1")).toThrow(/header lacks summary_line/);
  });
});
