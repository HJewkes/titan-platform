import { describe, expect, it } from "vitest";
import { emptyStageRuns, type StageBox, type StageMoment } from "./stage-empty-checks.js";

const STAGE = { x: 0, y: 120, width: 1920, height: 840 };
const content: StageBox = { element: "panel", box: { x: 200, y: 300, width: 600, height: 300 } };
const decorOnly: StageBox = { element: "marker", box: { x: 200, y: 300, width: 50, height: 50 }, decor: true };
const chromeOutsideStage: StageBox = { element: "headline", box: { x: 60, y: 20, width: 900, height: 70 } };

const at = (beat: string, t: number, boxes: StageBox[]): StageMoment => ({ beat, t, boxes });

describe("emptyStageRuns", () => {
  it("fails a 4 s empty run and names the beat and its span", () => {
    const moments = [at("b2", 0, [content]), at("b2", 2, []), at("b2", 4, [chromeOutsideStage]), at("b2", 6, [content])];

    expect(emptyStageRuns(moments, STAGE)).toEqual([
      { code: "stage-empty", severity: "error", message: "b2: stage empty from 2 s to 6 s (4 s, limit 3 s)", beat: "b2", t: 2 },
    ]);
  });

  it("passes a 2 s gap", () => {
    const moments = [at("b2", 0, [content]), at("b2", 1, []), at("b2", 2, []), at("b2", 3, [content])];

    expect(emptyStageRuns(moments, STAGE)).toEqual([]);
  });

  it("counts a stage holding only decor as empty", () => {
    const moments = [at("b3", 0, [decorOnly]), at("b3", 5, [decorOnly]), at("b3", 9, [content])];

    expect(emptyStageRuns(moments, STAGE)).toHaveLength(1);
  });

  it("passes a filled stage", () => {
    const moments = [at("b4", 0, [content]), at("b4", 5, [content]), at("b4", 10, [content])];

    expect(emptyStageRuns(moments, STAGE)).toEqual([]);
  });

  it("fails an empty run that reaches the beat's last sample", () => {
    const moments = [at("b5", 0, [content]), at("b5", 1, []), at("b5", 5, [])];

    expect(emptyStageRuns(moments, STAGE)[0]?.message).toContain("from 1 s to 5 s");
  });

  it("keeps beats apart, whatever order the moments arrive in", () => {
    const moments = [at("b6", 8, [content]), at("b7", 0, [content]), at("b6", 0, []), at("b7", 4, [content])];

    expect(emptyStageRuns(moments, STAGE).map((f) => f.beat)).toEqual(["b6"]);
  });
});
