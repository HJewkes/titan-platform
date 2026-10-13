import { describe, expect, it } from "vitest";
import { REVIEW_FILL_COMPARISON, SUCCESSOR_REWORK_COMPARISON, compareWindows } from "./compare-windows.js";
import { renderReviewFillText, renderSuccessorReworkText, renderWindowComparisonText } from "./render-guardrails.js";
import type { ReportWindow } from "./cost-report-queries.js";
import { LIST_PRICE_CAVEAT } from "./render-text.js";
import type { ReviewFillReport } from "./review-fill.js";
import type { SuccessorReworkReport } from "./successor-rework.js";

const BEFORE: ReportWindow = { since: "2026-01-01T00:00:00Z", until: "2026-01-02T00:00:00Z" };
const AFTER: ReportWindow = { since: "2026-01-02T00:00:00Z", until: "2026-01-03T00:00:00Z" };

function fillRow(overrides: Partial<ReviewFillReport["rows"][number]> = {}): ReviewFillReport["rows"][number] {
  return { band: "100-200k", model: "m", verdicts: 4, changesRequested: 1, changesRate: 0.25, verdictErrors: 1, errorRate: 0.25, ...overrides };
}

function fillReport(rows: ReviewFillReport["rows"], window = BEFORE): ReviewFillReport {
  return { window, unfilled: 2, unresolved: 1, rows };
}

function reworkReport(fileReadData: boolean, rows: SuccessorReworkReport["rows"], window = BEFORE): SuccessorReworkReport {
  return { window, bootRequests: 20, fileReadData, rows };
}

const IMPL = { role: "impl", pairs: 2, meanBootReads: 3, meanRereads: 1, rereadShare: 0.5, rereadCostUsd: 1.5 };

describe("renderReviewFillText", () => {
  it("prints rates as percentages, a null rate as '-', and no price caveat", () => {
    const text = renderReviewFillText(fillReport([fillRow(), fillRow({ model: "n", changesRate: null, errorRate: null })]));

    expect(text).toContain("25.0%");
    expect(text).toContain("Unfilled 2, unresolved pr_ref 1");
    const nullRow = text.split("\n").find((line) => line.startsWith("100-200k  n"));
    expect(nullRow).toMatch(/\s-\s.*\s-$/);
    expect(text).not.toContain("NaN");
    expect(text).not.toContain(LIST_PRICE_CAVEAT);
  });
});

describe("renderSuccessorReworkText", () => {
  it("warns that zero rework means no data when the graph has no file_read signal", () => {
    expect(renderSuccessorReworkText(reworkReport(false, []))).toContain("No file_read data");
    expect(renderSuccessorReworkText(reworkReport(true, [IMPL]))).not.toContain("No file_read data");
  });

  it("shows the reread cost in dollars and ends with the list-price caveat", () => {
    const text = renderSuccessorReworkText(reworkReport(true, [IMPL]));

    expect(text).toContain("$1.50");
    expect(text).toContain("50.0%");
    expect(text).toContain("A proxy for handoff quality, not a cost to minimise.");
    expect(text.endsWith(LIST_PRICE_CAVEAT)).toBe(true);
  });
});

describe("renderWindowComparisonText", () => {
  it("prints before, after and a signed after-minus-before delta, with '-' for a null delta", () => {
    const comparison = compareWindows(
      (window) => fillReport(window === BEFORE ? [fillRow()] : [fillRow({ verdicts: 6, changesRate: null })], window),
      BEFORE,
      AFTER,
      REVIEW_FILL_COMPARISON,
    );

    const text = renderWindowComparisonText(comparison, ["verdicts", "changesRate"]);

    expect(text).toContain("4 → 6 (+2)");
    expect(text).toContain("0.25 → - (-)");
    expect(text).toContain(BEFORE.since);
    expect(text).toContain(AFTER.until);
    expect(text).not.toContain(LIST_PRICE_CAVEAT);
  });

  it("prints '-' for every field of a key missing from one window", () => {
    const comparison = compareWindows(
      (window) => fillReport(window === BEFORE ? [] : [fillRow()], window),
      BEFORE,
      AFTER,
      REVIEW_FILL_COMPARISON,
    );

    expect(renderWindowComparisonText(comparison, ["verdicts"])).toContain("- → 4 (-)");
  });

  it("adds the list-price caveat when a column is in dollars", () => {
    const comparison = compareWindows(
      (window) => reworkReport(true, [window === BEFORE ? IMPL : { ...IMPL, rereadCostUsd: 2 }], window),
      BEFORE,
      AFTER,
      SUCCESSOR_REWORK_COMPARISON,
    );

    const text = renderWindowComparisonText(comparison, ["meanRereads", "rereadCostUsd"]);

    expect(text).toContain("$1.50 → $2.00 (+$0.50)");
    expect(text.endsWith(LIST_PRICE_CAVEAT)).toBe(true);
  });
});
