import type { ProbedMoment } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { narrationFactsReport, type ScreenText } from "./narration-facts.js";
import { readingHold, timingProfile } from "./timing-gates.js";

const label = (text: string, cls = "ex-label"): ScreenText => ({ text, tag: "span", cls });

describe("sibling counting figures", () => {
  const stat = (value: string, x: number) => ({ ...label(value, "ex-stat"), element: "span.beat-stat-figure", lines: [{ x, y: 300, width: 80, height: 40 }] });
  const ANCHORS = [40, 640, 1120, 1710];
  const counted = (steps: string[][]) => steps.map((values) => ({ beat: "b1", texts: values.map((value, i) => stat(value, ANCHORS[i]!)) }));

  it("four sibling stat figures counting up are each judged on the value they settle on", () => {
    // Arrange
    const moments = counted([["1", "2", "3", "4"], ["5", "6", "7", "8"], ["12", "40", "7", "9"]]);

    // Act
    const report = narrationFactsReport(moments, () => "twelve lanes, forty cards, seven runners and nine tags");

    // Assert
    expect(report.findings).toEqual([]);
  });

  it("a sibling figure that settles on an unspoken number is still a finding", () => {
    const moments = counted([["1", "2", "3", "4"], ["12", "40", "7", "9"], ["12", "41", "7", "9"]]);

    const report = narrationFactsReport(moments, () => "twelve lanes, forty cards, seven runners and nine tags");

    expect(report.findings.map((finding) => finding.fact)).toEqual(["41"]);
  });
});

describe("step numbers rising into place", () => {
  const step = (value: string, x: number, y: number) => ({ text: value, px: 48, tag: "span", cls: "ex-map-step", element: "span.ex-map-step", lines: [{ x, y, width: 24, height: 51 }], clips: [] });
  const at = (t: number, y: number, values = ["1", "2"]): ProbedMoment => ({ beat: "b1", t, texts: values.map((v, i) => step(v, 170 + i * 572, y)), boxes: [] });
  const gate = (probed: ProbedMoment[]) => {
    const timeline = { beats: [{ id: "b1", startS: 0, durationS: 4, cues: [] }] };
    return readingHold({ timeline, words: new Map([["b1", { durationS: 4, words: [] }]]), held: new Set(), diffs: [], fps: 30, probed, profile: timingProfile() });
  };

  it("a number that moves more than a few pixels as it enters is held for its whole stay", () => {
    // Arrange
    const probed = [at(0, 524), at(0.2, 519), at(0.5, 518.9), at(1, 518.9), at(3, 518.9), at(4, 518.9, [])];

    // Act
    const hold = gate(probed);

    // Assert
    expect(hold).toMatchObject({ value: 0, pass: true });
  });

  it("an unchanging number shown for less than the reading floor still fails the reading hold", () => {
    const probed = [at(0, 524), at(0.2, 519), at(0.5, 518.9, []), at(4, 518.9, [])];

    const hold = gate(probed);

    expect(hold).toMatchObject({ value: 2, pass: false, beats: ["b1"] });
  });
});
