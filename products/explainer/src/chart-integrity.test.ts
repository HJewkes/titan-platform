import { describe, expect, it } from "vitest";
import { chartFrameProblems, isMonotonicScale, lightness } from "./chart-integrity.js";
import { resolveScript, visual } from "./resolve-fixtures.test-helpers.js";
import { resolveConfig, runResolveStage } from "./resolve-stage.js";
import { sha256 } from "./workflow/artifacts.js";
import { runStageChecks } from "./workflow/stage-checks.js";

// Synthetic parcel-desk charts and textbook palettes; nothing here quotes a real script or video.
const SERIES = [{ id: "series-1", label: "Desk A", value: 40 }, { id: "series-2", label: "Desk B", value: 46 }];
const BLUES = ["#f7fbff", "#9ecae1", "#08306b"];
const JET = ["#0000ff", "#00ffff", "#ffff00", "#ff0000"];
const RED_BLUE = ["#b2182b", "#f7f7f7", "#2166ac"];
const bars = (frame: Record<string, unknown> = {}) => ({ kind: "bar", series: SERIES, ...frame });

/** The resolve body over an in-memory store with one chart beat pinned to `slots`, then the chart-integrity gate. */
function chartGate(slots: Record<string, unknown>) {
  const script = JSON.stringify(resolveScript([["b1", "WHAT", { visual: visual({ beat: "chart" }) }]]));
  const texts = { script, slots: JSON.stringify({ b1: slots }) };
  const bySha = new Map(Object.values(texts).map((text) => [sha256(text), text]));
  const store = { readText: (sha: string) => bySha.get(sha)!, putText: (text: string) => (bySha.set(sha256(text), text), sha256(text)) };
  const inputs = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, sha256(text)]));
  const outcome = runResolveStage({ artifacts: inputs, store, from: { runId: "r", stage: "resolve" }, remainingUsd: 1 }, resolveConfig());
  const checks = runStageChecks("resolve", { artifacts: { ...inputs, ...outcome.outputs }, store, l0Checks: [] });
  return checks.checks.find((check) => check.name === "chart-integrity");
}

describe("bar charts start at zero and draw no broken axis (CH-11, CH-13)", () => {
  it("refuses bars on a baseline above zero", () => {
    // Arrange / Act
    const problems = chartFrameProblems("chart", bars({ baseline: 30 }));

    // Assert
    expect(problems).toEqual(["bars start at 30, not zero; plot a dot or line chart, or the differences"]);
  });

  it("accepts bars on a zero or negative baseline, and a line on any baseline", () => {
    // Arrange / Act
    const problems = [bars({ baseline: 0 }), bars({ baseline: -10 }), { ...bars({ baseline: 30 }), kind: "line" }].flatMap((frame) => chartFrameProblems("chart", frame));

    // Assert
    expect(problems).toEqual([]);
  });

  it("refuses a broken axis on bars but not on a line", () => {
    // Arrange / Act
    const onBars = chartFrameProblems("replot", bars({ axisBreak: true }));
    const onLine = chartFrameProblems("replot", { ...bars({ axisBreak: true }), kind: "line" });

    // Assert
    expect(onBars).toEqual(["bars draw a broken axis; a break does not undo a truncated bar"]);
    expect(onLine).toEqual([]);
  });
});

describe("colour scales keep their lightness in order (CH-22)", () => {
  it("measures CIELAB lightness from black to white", () => {
    // Arrange / Act
    const ends = [lightness("#000000"), lightness("#ffffff"), lightness("#777777")];

    // Assert
    expect(ends.map((value) => Math.round(value))).toEqual([0, 100, 50]);
  });

  it("accepts a sequential ramp in either direction and refuses a rainbow", () => {
    // Arrange / Act
    const verdicts = [BLUES, [...BLUES].reverse(), JET].map((colours) => isMonotonicScale("sequential", colours));

    // Assert
    expect(verdicts).toEqual([true, true, false]);
  });

  it("accepts a diverging ramp light at its centre and refuses one that runs one way or repeats a step", () => {
    // Arrange / Act
    const verdicts = [RED_BLUE, BLUES, ["#b2182b", "#f7f7f7", "#f7f7f7", "#2166ac"]].map((colours) => isMonotonicScale("diverging", colours));

    // Assert
    expect(verdicts).toEqual([true, false, false]);
  });

  it("names the scale kind when a chart's ramp is out of order", () => {
    // Arrange / Act
    const problems = chartFrameProblems("chart", bars({ scale: { kind: "sequential", colours: JET } }));

    // Assert
    expect(problems).toEqual(["its sequential colour scale's lightness is not monotonic"]);
  });
});

describe("series carry direct labels, not a legend (CH-20)", () => {
  it("refuses a legend on a chart whose series each fit a label", () => {
    // Arrange / Act
    const problems = chartFrameProblems("replot", bars({ legend: true }));

    // Assert
    expect(problems).toEqual(["it draws a legend where direct labels fit; label each series instead"]);
  });

  it("allows a legend once there are more series than direct labels fit", () => {
    // Arrange
    const many = Array.from({ length: 7 }, (_, i) => ({ id: `series-${i + 1}`, label: `Desk ${i + 1}`, points: [] }));

    // Act
    const problems = chartFrameProblems("replot", { kind: "line", series: many, legend: true });

    // Assert
    expect(problems).toEqual([]);
  });
});

describe("resolve gates on chart integrity", () => {
  it("fails the chart-integrity gate on a truncated bar chart a slots pin sets", () => {
    // Arrange / Act
    const check = chartGate(bars({ baseline: 30, axisBreak: true }));

    // Assert
    expect(check).toMatchObject({ gate: true, pass: false });
    expect(check?.detail).toBe("chart integrity: b1: bars start at 30, not zero; plot a dot or line chart, or the differences; b1: bars draw a broken axis; a break does not undo a truncated bar");
  });

  it("passes a zero-based bar chart with an ordered ramp", () => {
    // Arrange / Act
    const check = chartGate(bars({ baseline: 0, scale: { kind: "sequential", colours: BLUES } }));

    // Assert
    expect(check).toEqual({ name: "chart-integrity", gate: true, pass: true, detail: "1 chart beats read true" });
  });
});
