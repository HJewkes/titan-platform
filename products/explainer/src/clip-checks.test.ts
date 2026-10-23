import { describe, expect, it } from "vitest";
import { clippedText, type MeasuredText } from "./clip-checks.js";
import { HEADLINE_BAND, threeLineHeadline, twoLineHeadline } from "./clip-fixtures.test-helpers.js";

const inBand = (lines: MeasuredText["lines"]): MeasuredText => ({ ...twoLineHeadline(), lines });

describe("clippedText", () => {
  it("fails a three-line headline whose unpainted band cuts off the third line", () => {
    expect(clippedText([threeLineHeadline()])).toEqual([
      {
        code: "clipped-text",
        severity: "error",
        message: 'b20-next headline: line 3 of 3 cut by headline-band (52 px): "Shipped: the first probe lands, the second gate follows, and"',
        beat: "b20-next",
        t: 9.5,
        elements: ["headline"],
      },
    ]);
  });

  it("passes a two-line headline that fits the band", () => {
    expect(clippedText([twoLineHeadline()])).toEqual([]);
  });

  it("passes a line that touches the band's edge within the tolerance", () => {
    const bottom = HEADLINE_BAND.y + HEADLINE_BAND.height;
    expect(clippedText([inBand([{ x: 60, y: bottom - 70, width: 900, height: 71 }])])).toEqual([]);
  });

  it("fails a line just past the tolerance", () => {
    const bottom = HEADLINE_BAND.y + HEADLINE_BAND.height;
    expect(clippedText([inBand([{ x: 60, y: bottom - 70, width: 900, height: 72 }])])).toHaveLength(1);
  });

  it("fails a line cut at the band's right edge", () => {
    const [finding] = clippedText([inBand([{ x: 60, y: 26, width: 1900, height: 70 }])]);
    expect(finding?.message).toContain("line 1 of 1 cut by headline-band (40 px)");
  });

  it("names the clip that cuts deepest when two ancestors clip the same line", () => {
    const text: MeasuredText = { ...threeLineHeadline(), clips: [...threeLineHeadline().clips, { element: "stage-clip", box: { x: 0, y: 0, width: 1920, height: 200 } }] };
    expect(clippedText([text])[0]?.message).toContain("cut by headline-band (52 px)");
  });

  it("lists every cut line in one finding per element", () => {
    const text: MeasuredText = { ...threeLineHeadline(), clips: [{ element: "headline-band", box: { x: 0, y: 0, width: 1920, height: 120 } }] };
    expect(clippedText([text]).map((finding) => finding.message)).toEqual([
      'b20-next headline: lines 2, 3 of 3 cut by headline-band (47 px): "Shipped: the first probe lands, the second gate follows, and"',
    ]);
  });

  it("reports nothing for text with no clipping ancestor", () => {
    expect(clippedText([{ ...threeLineHeadline(), clips: [] }])).toEqual([]);
  });

  it("omits the moment when the measurement has none", () => {
    const { t: _t, ...untimed } = threeLineHeadline();
    expect(clippedText([untimed])[0]).not.toHaveProperty("t");
  });
});
