import type { Moment, ProbedMoment } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { buildOccupancy } from "../occupancy-table.js";
import { FULL_STAGE } from "./qa-fakes.test-helpers.js";
import { settledOccupancy } from "./qa-measured.js";
import type { QaTimeline } from "./qa-timeline.js";

describe("settledOccupancy", () => {
  it("matches buildOccupancy over the settled probed moments only", () => {
    const moments: Moment[] = [{ beat: "b1", local: 0, t: 0, kind: "start", why: "start" }, { beat: "b1", local: 3.8, t: 3.8, kind: "end", why: "end" }];
    const probed: ProbedMoment[] = [0, 3.8].map((t) => ({ beat: "b1", t, ...FULL_STAGE }));
    const timeline: QaTimeline = { beats: [{ id: "b1", kind: "title", startS: 0, durationS: 4, cues: [] }] };
    const stage = { width: 1920, height: 1080 };
    const elements = FULL_STAGE.boxes.map((box) => ({ id: box.element, box: box.box }));

    const tables = settledOccupancy({ timeline, moments, probed, stage });

    expect(tables).toEqual(buildOccupancy({ stage, layouts: [], marks: [{ beat: "b1", t: 3.8, elements }] }));
    expect(tables).toHaveLength(1);
  });
});
