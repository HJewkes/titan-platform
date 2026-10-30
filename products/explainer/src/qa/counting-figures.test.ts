import { describe, expect, it } from "vitest";
import { narrationFactsReport, type ScreenText } from "./narration-facts.js";

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
