import { describe, expect, it } from "vitest";
import { PageMarksSchema } from "../contact-sheet.js";
import { timelineMarks } from "./timeline-marks.js";
import { parseTimeline } from "./timeline.js";

function timelineOf(beats: object[]) {
  return parseTimeline({ durationS: 60, beats });
}

describe("timelineMarks", () => {
  it("settles a beat at its latest reveal's landing", () => {
    const timeline = timelineOf([
      { id: "b1", kind: "stage", startS: 4, durationS: 8, slots: {}, reveals: [{ target: "a", atS: 2 }] },
    ]);

    const marks = timelineMarks(timeline, 1.0);

    expect(marks).toContainEqual({ t: 7.0, beat: "b1", kind: "settled" });
  });

  it("gives a list beat one step mark per reveal in reveal order", () => {
    const timeline = timelineOf([
      {
        id: "list",
        kind: "list",
        startS: 10,
        durationS: 9,
        slots: {},
        reveals: [
          { target: "one", atS: 1 },
          { target: "two", atS: 3 },
          { target: "three", atS: 5 },
        ],
      },
    ]);

    const steps = timelineMarks(timeline, 0.5).filter((m) => m.kind === "step");

    expect(steps.map((m) => m.t)).toEqual([11.5, 13.5, 15.5]);
  });

  it("gives a beat with no reveals one settled mark", () => {
    const timeline = timelineOf([{ id: "plain", kind: "stage", startS: 2, durationS: 4, slots: {} }]);

    expect(timelineMarks(timeline)).toEqual([{ t: 2.5, beat: "plain", kind: "settled" }]);
  });

  it("emits marks that parse with PageMarksSchema", () => {
    const timeline = timelineOf([
      { id: "a", kind: "list", startS: 0, durationS: 5, slots: {}, reveals: [{ target: "x", atS: 1 }, { target: "y", atS: 2 }] },
      { id: "b", kind: "stage", startS: 5, durationS: 3, slots: {} },
    ]);

    expect(() => PageMarksSchema.parse(timelineMarks(timeline))).not.toThrow();
  });
});
