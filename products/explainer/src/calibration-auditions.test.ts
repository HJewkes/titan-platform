import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { auditionOutputs, type AuditionEntry } from "./calibration-auditions.js";
import { auditionEntry, type Scores } from "./calibration-fakes.test-helpers.js";

let dir: string;

const entry = (name: string, pick: Scores | null, runnerUp: Scores | null): AuditionEntry => auditionEntry(dir, name, pick, runnerUp);

const pickSide = (outputs: ReturnType<typeof auditionOutputs>) => (outputs.find((o) => o.judge === "audition-code")!.pass ? "A" : "B");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explainer-calibration-auditions-"));
});

describe("auditionOutputs", () => {
  it("makes the pick and runner-up one pair question, with the code picker preferring the pick's side", () => {
    const outputs = auditionOutputs(entry("a", { J8: 4, J9: 4 }, { J8: 2, J9: 2 }), "s1");

    expect(new Set(outputs.map((o) => o.group)).size).toBe(1);
    expect(outputs.map((o) => [o.judge, o.kind])).toEqual([["audition-code", "pair"], ["audition-rubric", "pair"]]);
    const pickAt = outputs[0]!.excerpt.indexOf("The north desk");
    const bAt = outputs[0]!.excerpt.indexOf("Storyboard B");
    expect(pickSide(outputs)).toBe(pickAt < bAt ? "A" : "B");
  });

  it("has the rubric picker prefer the higher J8 to J11 sum, leaving out J12 and a row voided on either side", () => {
    const outputs = auditionOutputs(entry("v", { J8: 3, J9: 3, J10: null, J11: 4, J12: 1 }, { J8: 2, J9: 3, J10: 5, J11: null, J12: 5 }), "s1");

    const rubric = outputs.find((o) => o.judge === "audition-rubric");
    expect(rubric?.pass).toBe(pickSide(outputs) === "A");
  });

  it("gives no rubric entry on a tie or when a side has no rubric", () => {
    expect(auditionOutputs(entry("t", { J8: 3, J9: 2 }, { J8: 2, J9: 3 }), "s1").map((o) => o.judge)).toEqual(["audition-code"]);
    expect(auditionOutputs(entry("n", null, { J8: 2 }), "s1").map((o) => o.judge)).toEqual(["audition-code"]);
  });

  it("fixes the A/B order for a seed and puts the pick on both sides across pairs", () => {
    const entries = Array.from({ length: 8 }, (_, n) => entry(`o${n}`, { J8: 3 }, { J8: 2 }));

    const sides = (seed: string) => entries.map((e) => pickSide(auditionOutputs(e, seed)));

    expect(sides("s1")).toEqual(sides("s1"));
    expect(new Set(sides("s1"))).toEqual(new Set(["A", "B"]));
  });

  it("shows the owner both storyboards without a structure, system, candidate id or score", () => {
    const [output] = auditionOutputs(entry("h", { J8: 3 }, { J8: 2 }), "s1");

    expect(output!.excerpt).toMatch(/Storyboard A[\s\S]*Why does the (north|south) desk refuse it\? \(30 s\)[\s\S]*Storyboard B/);
    for (const hidden of ["shape-", "system-", "h-p", "h-r", "-open", "0.913", "0.42", "ledger"]) expect(output!.excerpt + output!.question).not.toContain(hidden);
  });

  it("refuses a record that is not audition/v1 with a message naming the file", () => {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ schema: "audition/v0" }));

    expect(() => auditionOutputs({ ...entry("x", null, null), record: bad }, "s1")).toThrow(/bad\.json is not a readable audition\/v1/);
  });
});
