import { describe, expect, it } from "vitest";
import { measureTable, summarizeMeasure, type MeasureInput, type TargetRowId } from "./rewrite-measure.js";
import type { TargetRow } from "./rewrite-pass.js";

type Values = Record<TargetRowId, number>;

// Every target row in band: numbers and triads under their caps, sentence shape above its floors, few crowded beats.
const GREEN: Values = {
  "register:numbers": 20,
  "register:numbers-per-beat": 0.1,
  "register:triads": 1,
  "register:sentence-mean": 14,
  "register:sentence-cv": 0.6,
};
const RED: Values = {
  "register:numbers": 40,
  "register:numbers-per-beat": 0.4,
  "register:triads": 6,
  "register:sentence-mean": 9,
  "register:sentence-cv": 0.4,
};

const rows = (values: Partial<Values> = {}): TargetRow[] =>
  Object.entries({ ...GREEN, ...values }).map(([check_id, value]) => ({ check_id, value, threshold: 0, pass: true }));

const input = (name: string, samples: Partial<Values>[], before: Partial<Values> = RED): MeasureInput =>
  ({ name, before: rows(before), samples: samples.map((values) => rows(values)) });

const cellOf = (inputs: MeasureInput[], name: string, row: TargetRowId, reportOnly?: Set<string>) =>
  summarizeMeasure(inputs, reportOnly).cells.find((cell) => cell.input === name && cell.row === row)!;
const rowOf = (inputs: MeasureInput[], row: TargetRowId, reportOnly?: Set<string>) =>
  summarizeMeasure(inputs, reportOnly).rows.find((r) => r.row === row)!;

describe("summarizeMeasure", () => {
  it("reports each cell's mean, sample sd and sample count", () => {
    const inputs = [input("a", [{ "register:numbers": 20 }, { "register:numbers": 22 }, { "register:numbers": 24 }])];

    expect(cellOf(inputs, "a", "register:numbers")).toMatchObject({ before: 40, mean: 22, sd: 2, n: 3, inBand: true, closer: true });
  });

  it("calls an out-of-band cell closer when its mean is nearer the band than before", () => {
    const inputs = [input("a", [{ "register:numbers": 27 }, { "register:numbers": 28 }])];

    expect(cellOf(inputs, "a", "register:numbers")).toMatchObject({ inBand: false, closer: true });
  });

  it("calls a cell that started in band and left it not closer", () => {
    const inputs = [input("a", [{ "register:triads": 3 }, { "register:triads": 3.2 }], GREEN)];

    expect(cellOf(inputs, "a", "register:triads")).toMatchObject({ inBand: false, closer: false });
  });

  it("decides a cell whose margin to the band edge beats its noise and leaves a near-edge cell within noise", () => {
    const far = input("far", [{ "register:numbers": 20 }, { "register:numbers": 22 }, { "register:numbers": 24 }]);
    const near = input("near", [{ "register:numbers": 23 }, { "register:numbers": 25 }, { "register:numbers": 27 }]);

    expect(cellOf([far, near], "far", "register:numbers").decided).toBe(true);
    expect(cellOf([far, near], "near", "register:numbers").decided).toBe(false);
  });

  it("never decides a single-sample cell, and judges its row by the band alone", () => {
    const inputs = [input("a", [{ "register:triads": 2.3 }])];

    expect(cellOf(inputs, "a", "register:triads")).toMatchObject({ n: 1, decided: false });
    expect(cellOf(inputs, "a", "register:triads").sd).toBeUndefined();
    expect(rowOf(inputs, "register:triads")).toMatchObject({ withinSigma: false, pass: false });
  });

  it("passes a row whose mean over inputs sits outside the band but within one pooled sample sd", () => {
    const inputs = [
      input("a", [{ "register:triads": 2 }, { "register:triads": 3 }]),
      input("b", [{ "register:triads": 2 }, { "register:triads": 3 }]),
    ];

    const row = rowOf(inputs, "register:triads");
    expect(row).toMatchObject({ mean: 2.5, inBand: false, withinSigma: true, everyInputCloser: true, pass: true });
    expect(row.sigma).toBeCloseTo(Math.SQRT1_2);
  });

  it("fails a row when one input moved away from its band, unless that cell is report-only", () => {
    const inputs = [input("a", [{ "register:numbers": 20 }, { "register:numbers": 21 }]), input("b", [{ "register:numbers": 26 }, { "register:numbers": 26 }], GREEN)];

    expect(rowOf(inputs, "register:numbers").everyInputCloser).toBe(false);
    expect(rowOf(inputs, "register:numbers", new Set(["b:register:numbers"]))).toMatchObject({ everyInputCloser: true, pass: true });
  });

  it("measures a stage with no before, such as script: a cell is closer only when its mean is in band", () => {
    const inputs: MeasureInput[] = [{ name: "a", samples: [rows({ "register:triads": 1 }), rows({ "register:triads": 3 })] }];

    expect(cellOf(inputs, "a", "register:triads")).toMatchObject({ mean: 2, n: 2, inBand: true, closer: true });
    expect(cellOf(inputs, "a", "register:triads").before).toBeUndefined();
    expect(cellOf([{ name: "a", samples: [rows({ "register:triads": 4 })] }], "a", "register:triads")).toMatchObject({ inBand: false, closer: false });
  });

  it("passes the measure only when all five target rows pass", () => {
    const green = [input("a", [{}, {}])];
    const oneRed = [input("a", [{ "register:sentence-cv": 0.3 }, { "register:sentence-cv": 0.31 }], GREEN)];

    expect(summarizeMeasure(green).pass).toBe(true);
    expect(summarizeMeasure(oneRed).pass).toBe(false);
  });
});

describe("measureTable", () => {
  it("prints the crowded-beat share as a percentage against its 24% cap", () => {
    const table = measureTable(summarizeMeasure([input("a", [{ "register:numbers-per-beat": 0.1 }, { "register:numbers-per-beat": 0.2 }])]));

    expect(table).toContain("| a | register:numbers-per-beat | <= 24.0% | 40.0% | 15.0% ± 7.1% | 2 | yes | yes |");
    expect(table).toContain("Revised done-when: PASS");
  });

  it("prints a dash for the before of a stage that has none", () => {
    const table = measureTable(summarizeMeasure([{ name: "a", samples: [rows(), rows()] }]));

    expect(table).toContain("| a | register:numbers | <= 25.62 | — | 20.00 ± 0.00 | 2 | yes | yes |");
  });
});
