import { describe, expect, it } from "vitest";
import { summarizeMeasure, type MeasureInput, type TargetRowId } from "../rewrite-measure.js";
import type { TargetRow } from "../rewrite-pass.js";
import { armVerdict, compareArms, compareTable } from "./samples-compare.js";

const IN_BAND: Record<TargetRowId, number> = {
  "register:numbers": 20,
  "register:numbers-per-beat": 0.1,
  "register:triads": 1,
  "register:sentence-mean": 14,
  "register:sentence-cv": 0.6,
};
const rows = (values: Partial<Record<TargetRowId, number>>): TargetRow[] =>
  Object.entries({ ...IN_BAND, ...values }).map(([check_id, value]) => ({ check_id, value, threshold: 0, pass: true }));
const arm = (numbers: number[]): MeasureInput[] => [{ name: "case-a", samples: numbers.map((n) => rows({ "register:numbers": n })) }];
const numbersRow = (a: number[], b: number[], floor?: Partial<Record<TargetRowId, number>>) =>
  compareArms(summarizeMeasure(arm(a)), summarizeMeasure(arm(b)), floor).find((row) => row.row === "register:numbers")!;

// The numbers band is 11.92 to 25.62 per 1k words, so 27 to 30 is out of band above it, 30 further out than 27.
describe("compareArms", () => {
  it("reports a stage diff inside the A/A floor as noise, not as a win, though B moved toward the band", () => {
    const row = numbersRow([30, 30, 30], [28, 28, 28], { "register:numbers": 1.5 });

    expect(row).toMatchObject({ meanA: 30, meanB: 28, diff: -2, sigma: 1.5, sigmaFrom: "floor", verdict: "noise" });
  });

  it("calls the same move a win once it clears 2σ of the floor, though the arms' own σ would call it noise", () => {
    const [a, b] = [[28, 30, 32], [25, 27, 29]];

    expect(numbersRow(a, b).verdict).toBe("noise");
    expect(numbersRow(a, b, { "register:numbers": 1.4 }).verdict).toBe("win");
  });

  it("calls a move past 2σ away from the band a loss", () => {
    expect(numbersRow([27, 27, 27], [30, 30, 30], { "register:numbers": 1.4 }).verdict).toBe("loss");
  });

  it("falls back to the arms' pooled sample σ for a row the floor lacks", () => {
    const row = numbersRow([29, 30, 31], [28, 29, 30]);

    expect(row).toMatchObject({ sigma: 1, sigmaFrom: "arms", verdict: "noise" });
  });

  it("calls a single-sample comparison with no floor unknown", () => {
    const row = numbersRow([30], [20]);

    expect(row.verdict).toBe("unknown");
    expect(row.sigma).toBeUndefined();
  });
});

describe("armVerdict", () => {
  const band = { min: 10, max: 20 };

  it("holds a diff of exactly 2σ as noise", () => {
    expect(armVerdict(band, 30, 28, 1)).toBe("noise");
    expect(armVerdict(band, 30, 27.99, 1)).toBe("win");
  });

  it("calls a big move inside the band a shift, neither a win nor a loss", () => {
    expect(armVerdict(band, 12, 18, 1)).toBe("shift");
  });

  it("judges a move toward a floor-only band from below as a win", () => {
    expect(armVerdict({ min: 13, max: Infinity }, 9, 12, 1)).toBe("win");
  });
});

describe("compareTable", () => {
  it("prints each row's means, signed diff, σ with its source and verdict", () => {
    const table = compareTable([numbersRow([30, 30, 30], [28, 28, 28], { "register:numbers": 1.5 })], { a: "champion", b: "champion'" });

    expect(table).toContain("| register:numbers | 30.000 | 28.000 | -2.000 | 1.500 (floor) | ± 3.000 | noise |");
  });
});
