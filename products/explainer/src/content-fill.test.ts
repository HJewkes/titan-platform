import { describe, expect, it } from "vitest";
import { contentFill, contentFillFindings } from "./content-fill.js";
import type { StageBox, StageMoment } from "./stage-empty-checks.js";

const FRAME = { width: 1920, height: 1080 };
const box = (element: string, x: number, width: number, y = 400, height = 120): StageBox => ({ element, box: { x, y, width, height } });
const settled = (beat: string, boxes: StageBox[]): StageMoment => ({ beat, t: 4.8, boxes });

/** Styled in fixed px for a 1280×720 stage, centred on the column axis only, so pinned to the left of 1920×1080. */
const S4_STYLED = [
  settled("b01-title", [box("title", 96, 620), box("subtitle", 96, 540, 540, 40)]),
  settled("b02-stat", [box("stat-value", 96, 300, 360, 160), box("stat-delta", 96, 180, 540, 40)]),
  settled("b05-checks", [box("check-1", 96, 700, 300, 48), box("check-2", 96, 640, 360, 48), box("check-3", 96, 660, 420, 48)]),
  settled("b09-outro", [box("title", 96, 620), box("subtitle", 96, 480, 540, 40)]),
];

/** Authored at 1920×1080: cards stretch to an 80 % content box, side-by-side panels share it. */
const S6_STYLED = [
  settled("b03-code", [box("card", 192, 1536, 200, 680), box("line-3", 240, 520, 420, 40)]),
  settled("b04-compare", [box("left", 192, 752, 200, 600), box("right", 976, 752, 200, 600)]),
  settled("b06-graph", [box("col-1", 192, 480), box("col-2", 720, 480), box("col-3", 1248, 480)]),
];

describe("contentFillFindings", () => {
  it("fails the four S4-styled beats and passes the S6 beats", () => {
    const findings = contentFillFindings([...S4_STYLED, ...S6_STYLED], FRAME);

    expect(findings.map((finding) => finding.beat)).toEqual(["b01-title", "b02-stat", "b05-checks", "b09-outro"]);
    expect(findings[0]).toEqual({ code: "content-fill", severity: "error", message: "b01-title: content spans 32 % of the frame width (floor 60 %)", beat: "b01-title", t: 4.8 });
  });

  it("measures the union of element boxes, so a short line inside a stretched card passes", () => {
    const fill = contentFill(S6_STYLED[0]!, FRAME);

    expect(fill).toBeCloseTo(0.8);
  });

  it("counts overlapping boxes once", () => {
    const moment = settled("b07-stack", [box("back", 0, 1000), box("front", 500, 500)]);

    expect(contentFill(moment, FRAME)).toBeCloseTo(1000 / 1920);
  });

  it("ignores decor, empty boxes and the parts of a box off the frame", () => {
    const moment = settled("b08-rows", [
      { ...box("rule", 0, 1920), decor: true },
      box("collapsed", 0, 1920, 400, 0),
      box("below", 0, 1920, 1200),
      box("bleed", 1500, 900),
    ]);

    expect(contentFill(moment, FRAME)).toBeCloseTo(420 / 1920);
  });
});
