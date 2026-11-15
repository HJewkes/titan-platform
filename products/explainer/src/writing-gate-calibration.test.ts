import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shippedGatePolicy } from "./writing-gate-fixtures.test-helpers.js";
import { writingGateRows } from "./writing-gate.js";

// Synthetic stand-ins for the lab's two rejected scripts and two E4 pieces (the originals are
// private). Each keeps the defect that matters: the rejected pair has a short sentence mean and no
// sentence over 30 words; the E4 pair has a long mean and a real share of long sentences.
const fixture = (name: string) => readFileSync(new URL(`../fixtures/writing-gate/${name}`, import.meta.url), "utf8");

const beatsOf = (name: string) =>
  fixture(name)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((spoken, i) => ({ id: `b${i + 1}`, spoken }));

const rowOf = (name: string, id: string) => writingGateRows(beatsOf(name), shippedGatePolicy()).find((row) => row.id === id)!;

const REJECTED = ["ours-bread-r1.md", "ours-nn-ep1-r1.md"];
const E4 = ["e4-s-bread-final.md", "e4-s-nn1-final.md"];

describe("writing gate calibration on the reference pieces", () => {
  it.each(REJECTED)("fails short-register as an error on rejected script %s", (name) => {
    expect(rowOf(name, "writing:short-register")).toMatchObject({ severity: "error", pass: false });
  });

  it.each(E4)("passes short-register on E4 piece %s", (name) => {
    expect(rowOf(name, "writing:short-register")).toMatchObject({ pass: true });
  });

  it.each(REJECTED)("puts the sentence mean of rejected script %s under 12", (name) => {
    expect(rowOf(name, "writing:sentence-mean").value).toBeLessThan(12);
  });

  it.each(E4)("puts the sentence mean of E4 piece %s over 12", (name) => {
    expect(rowOf(name, "writing:sentence-mean").value).toBeGreaterThan(12);
  });
});
