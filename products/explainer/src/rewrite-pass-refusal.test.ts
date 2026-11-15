import { describe, expect, it } from "vitest";
import type { L0Result } from "./eval-l0.js";
import { chapterRefusal } from "./rewrite-pass.js";

const row = (check_id: string, value: number, threshold: number, pass: boolean): L0Result => ({
  check_id, mode: "heuristic", severity: "warning", value, threshold, pass, detail_beats: [],
});

describe("chapterRefusal", () => {
  const before = [row("register:sentence-mean", 6, 12.51, false), row("register:contractions", 12, 40.18, true)];
  const closer = row("register:sentence-mean", 10, 12.51, false);
  const guarded = new Set(["register:contractions"]);
  const keepCloser = (rows: L0Result[]): L0Result[] => rows.map((r) => (r.check_id === closer.check_id ? closer : r));

  it("names a hallmark row that was green and turns red, though it is not in the guarded set", () => {
    const withHallmark = [...before, row("hallmark:staccato-run", 0, 0, true)];
    const flipped = keepCloser(withHallmark).map((r) => (r.check_id === "hallmark:staccato-run" ? row("hallmark:staccato-run", 2, 0, false) : r));
    expect(chapterRefusal(withHallmark, flipped, guarded)).toEqual({ why: "a protected row turned red", rows: ["hallmark:staccato-run"] });
  });

  it("lets a hallmark row that was already red stay red", () => {
    const redBefore = [...before, row("hallmark:staccato-run", 2, 0, false)];
    expect(chapterRefusal(redBefore, keepCloser(redBefore), guarded)).toBeUndefined();
  });

  it("never refuses a report-only hallmark row, which passes by construction", () => {
    const reportOnly = [...before, row("hallmark:parallel-recap", 3, 0, true)];
    expect(chapterRefusal(reportOnly, keepCloser(reportOnly), guarded)).toBeUndefined();
  });
});
