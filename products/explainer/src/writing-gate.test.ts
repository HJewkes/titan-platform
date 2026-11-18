import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerCheck } from "./lint-register.js";
import { lint, tour, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";
import { parseWritingCheck } from "./writing-calibrate.js";
import { scoreWriting } from "./writing-check.js";
import { shippedGatePolicy } from "./writing-gate-fixtures.test-helpers.js";
import { writingGateCheck, writingGateRows } from "./writing-gate.js";

// Synthetic kettle lines. SHORT is 8 words; LONG is 19; OVER_30 is 31.
const SHORT = "The kettle sits on the stove all day.";
const LONG = "The kettle on the back burner hums for a long while before it starts to whistle at the cook.";
const OVER_30 = "The old kettle on the back burner hums for a long while before the water inside it boils and the steam finally finds the narrow spout and starts to whistle loudly.";

const beatsOf = (lines: readonly string[]) => lines.map((spoken, i) => ({ id: `b${i + 1}`, spoken }));
const repeat = (line: string, n: number): string[] => Array.from({ length: n }, () => line);
const rowOf = (lines: readonly string[], id: string, policy = shippedGatePolicy()) => writingGateRows(beatsOf(lines), policy).find((row) => row.id === id)!;

describe("writing:short-register", () => {
  it("fails 200 words of 8-word sentences, as an error", () => {
    expect(rowOf(repeat(SHORT, 25), "writing:short-register")).toMatchObject({ value: 8, severity: "error", pass: false });
  });

  it("passes 190 words with a 19-word mean and no sentence over 30 words: the short mean is needed too", () => {
    expect(rowOf(repeat(LONG, 10), "writing:short-register")).toMatchObject({ value: 19, pass: true });
  });

  it("passes 8-word sentences once enough of them run past 30 words: the missing long sentences are needed too", () => {
    expect(rowOf([...repeat(SHORT, 22), OVER_30, OVER_30], "writing:short-register").pass).toBe(true);
  });

  it("reads its thresholds from the policy, so a raised floor fails the 19-word text", () => {
    const raised = shippedGatePolicy();
    raised.gate["short-register"] = { ...raised.gate["short-register"], meanBelow: 25, longShareBelow: 0.5 };

    expect(rowOf(repeat(LONG, 10), "writing:short-register", raised)).toMatchObject({ threshold: 25, pass: false });
  });
});

describe("writing gate rows under 150 words", () => {
  it("are all report-only and pass, however short the register", () => {
    const rows = writingGateRows(beatsOf(repeat(SHORT, 15)), shippedGatePolicy());

    expect(rows.map((row) => [row.id, row.severity, row.pass])).toEqual([
      ["writing:short-register", "report-only", true],
      ["writing:sentence-mean", "report-only", true],
      ["writing:long-share", "report-only", true],
      ["writing:first-person", "report-only", true],
      ["writing:beat-length-cv", "report-only", true],
    ]);
  });
});

describe("writing:long-share", () => {
  it("reports only under 600 words and warns at 600", () => {
    expect(rowOf(repeat(LONG, 20), "writing:long-share")).toMatchObject({ severity: "report-only", pass: true });
    expect(rowOf(repeat(LONG, 32), "writing:long-share")).toMatchObject({ severity: "warning", pass: false, value: 0 });
  });
});

describe("Q-V16 at L0", () => {
  const specs = (line: string, n: number): BeatSpec[] => Array.from({ length: n }, (_, i): BeatSpec => [`b${i + 1}`, "ch1", "WHAT", line]);
  const tourOf = (line: string, n: number) => tour(specs(line, n), { thesis_refs: ["b1", "b2", "b3"] });

  it("fails a script/v1 tour in the short register as an error row", () => {
    const row = lint(tourOf(SHORT, 25), [writingGateCheck]).get("writing:short-register");

    expect(row).toMatchObject({ severity: "error", pass: false, value: 8, threshold: 12 });
  });

  it("is a passing warning on a 120-word tour", () => {
    expect(lint(tourOf(SHORT, 15), [writingGateCheck]).get("writing:short-register")).toMatchObject({ severity: "warning", pass: true });
  });
});

describe("the owner's report-only overrides", () => {
  const STOCK = "The kettle matters most to the cook, and the cook matters most to the kettle.";
  const lines = [...repeat(LONG, 20), STOCK, STOCK, STOCK];

  it("make phrases report-only in eval writing though the calibrated table says warning", () => {
    const table = parseWritingCheck(readFileSync(new URL("../doctrine/writing-check.json", import.meta.url), "utf8"));
    table.statusByBucket.phrases = { "150-299": "warning", "300-599": "warning", "600-1199": "warning", "1200+": "warning", full: "warning" };

    const row = scoreWriting(beatsOf(lines), table).rows.find((candidate) => candidate.metric === "phrases")!;

    expect(row.value).toBeGreaterThan(row.band.max);
    expect(row).toMatchObject({ status: "report-only", verdict: "not-judged" });
  });

  it("keep register:phrases passing at L0, with its value", () => {
    const specs = lines.map((line, i): BeatSpec => [`b${i + 1}`, "ch1", "WHAT", line]);

    const row = lint(tour(specs, { thesis_refs: ["b1", "b2", "b3"] }), [registerCheck]).get("register:phrases")!;

    expect(row.value).toBeGreaterThan(row.threshold);
    expect(row.pass).toBe(true);
  });
});
