import { DEFAULT_OPTIONS, type Finding } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { failedGates } from "../workflow/stage-checks.js";
import { contrastRatio, contrastReport, inPageCovers } from "./contrast-check.js";
import { CONTRAST } from "./gate-profile.js";
import { qaStageHarness } from "./qa-stage.test-helpers.js";

// Synthetic parcel-desk charts and greys; nothing here quotes a real script or video.
const harness = qaStageHarness();

const chartBeat = (slots: Record<string, unknown>) => ({ id: "b1", kind: "chart", startS: 0, durationS: 4, slots });
const DESKS = [{ id: "desk-a", label: "Desk A", value: 10 }, { id: "desk-b", label: "Desk B", value: 20 }];
/** A ramp whose low end is a near-black that vanishes into the bar track. */
const DIM_RAMP = { kind: "sequential", colours: ["#202020", "#e0e0e0"] };

const runChart = (slots: Record<string, unknown>, findingsAt?: () => Finding[]) =>
  harness.run({ ...(findingsAt ? { findingsAt } : {}) }, { timeline: { durationS: 4, beats: [chartBeat(slots)] } as { durationS: number } });

const lowContrast = (text: string, px: number, ratio: number): Finding => ({ kind: "low-contrast", el: "span.label", text, px, ratio, at: { x: 100, y: 200, w: 300, h: px } });

describe("WCAG contrast ratio", () => {
  it("runs from 1 for one colour against itself to 21 for black on white", () => {
    // Arrange / Act
    const ratios = [contrastRatio("#000000", "#ffffff"), contrastRatio("#ffffff", "#000000"), contrastRatio("#777777", "#777777")];

    // Assert
    expect(ratios.map((ratio) => Math.round(ratio * 100) / 100)).toEqual([21, 21, 1]);
  });
});

describe("qa stage chart-mark contrast (WCAG 1.4.11)", () => {
  it("reports a bar whose scale colour sits under 3:1 on its track, and never fails the stage", async () => {
    // Arrange / Act
    const { report, checks } = await runChart({ kind: "bar", series: DESKS, scale: DIM_RAMP });

    // Assert
    expect(report.contrast?.marks.checked).toBe(2);
    expect(report.contrast?.marks.below.map(({ mark, colour }) => `${mark} ${colour}`)).toEqual(["desk-a #202020"]);
    expect(checks["chart-mark-contrast"]).toMatchObject({ gate: false, pass: false });
    expect(checks["chart-mark-contrast"]?.detail).toMatch(/^1\/2 chart marks under 3:1: \[b1\] desk-a #202020 on #31302F 1\.\d\d:1$/);
    expect(failedGates(Object.values(checks))).toEqual([]);
  });

  it("passes a line chart in the theme's own series colour", async () => {
    // Arrange / Act
    const { checks } = await runChart({ kind: "line", series: DESKS });

    // Assert
    expect(checks["chart-mark-contrast"]).toMatchObject({ gate: false, pass: true, detail: "2 chart marks at 3:1 or more" });
  });

  it("names a chart kind the page does not draw as a fallback rather than checking it", () => {
    // Arrange
    const beats = [chartBeat({ kind: "gauge", series: DESKS })];

    // Act
    const report = contrastReport(beats, [], CONTRAST, DEFAULT_OPTIONS);

    // Assert
    expect(report.marks.checked).toBe(0);
    expect(report.fallbacks).toContain("b1: chart kind gauge is not drawn, so its marks were not checked");
  });
});

describe("qa stage text contrast (WCAG 1.4.3)", () => {
  it("holds small text to 4.5:1 and large text to 3:1 by WCAG's 24 px size", async () => {
    // Arrange
    const findings = [lowContrast("Parcels waiting", 20, 4.2), lowContrast("Desk B", 30, 3.6)];

    // Act
    const { report, checks } = await runChart({ kind: "line", series: DESKS }, () => findings);

    // Assert
    expect(report.contrast?.text.below).toEqual([{ beat: "b1", text: "Parcels waiting", px: 20, ratio: 4.2, need: 4.5 }]);
    expect(checks["text-contrast"]).toMatchObject({ gate: false, pass: false, detail: '1 text runs under contrast: [b1] "Parcels waiting" 20 px 4.2:1 (needs 4.5:1)' });
  });

  it("passes when render-qa measured no text under its thresholds", async () => {
    // Arrange / Act
    const { checks } = await runChart({ kind: "line", series: DESKS });

    // Assert
    expect(checks["text-contrast"]).toMatchObject({ gate: false, pass: true, detail: "no text under the contrast thresholds" });
  });
});

describe("gate profile contrast thresholds", () => {
  it("are covered by render-qa's in-page thresholds, so every text run under them is recorded", () => {
    // Arrange / Act
    const report = contrastReport([], [], CONTRAST, DEFAULT_OPTIONS);

    // Assert
    expect(inPageCovers(DEFAULT_OPTIONS, CONTRAST)).toBe(true);
    expect(report.thresholds).toEqual({ text: 4.5, largeText: 3, largeTextPx: 24, nonText: 3 });
  });

  it("names the gap when a profile loosens render-qa below them", () => {
    // Arrange
    const loose = { ...DEFAULT_OPTIONS, minContrast: 3 };

    // Act
    const report = contrastReport([], [], CONTRAST, loose);

    // Assert
    expect(report.fallbacks).toContain("text: render-qa's in-page thresholds are looser than these, so runs between the two go unseen");
  });
});
