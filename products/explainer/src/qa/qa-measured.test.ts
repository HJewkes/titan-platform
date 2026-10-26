import type { ProbedMoment } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { RENDER_FPS } from "../render/render-video.js";
import { FULL_STAGE } from "./qa-fakes.test-helpers.js";
import { qaStageHarness } from "./qa-stage.test-helpers.js";

const harness = qaStageHarness();

type Probe = Pick<ProbedMoment, "texts" | "boxes">;

/** Two 4 s beats back to back. */
const TWO_BEATS = {
  durationS: 8,
  beats: [
    { id: "b1", kind: "title", startS: 0, durationS: 4, slots: {} },
    { id: "b2", kind: "title", startS: 4, durationS: 4, slots: {} },
  ],
};

/** The full stage drawn at a third of its scale, pinned to the left edge: a 1280-wide layout shrunk onto 1920. */
const THIRD_SCALE: Probe = {
  texts: [],
  boxes: FULL_STAGE.boxes.map(({ element, box }) => ({ element, box: { x: box.x / 3, y: box.y / 3, width: box.width / 3, height: box.height / 3 } })),
};

/** The X3 b20 headline: three lines in a band sized for two, whose overflow is hidden and which paints nothing. */
const LINE = { x: 100, width: 600, height: 70 };
const CLIPPED_HEADLINE: Probe = {
  texts: [{
    text: "Every parcel the desk cannot place waits in the hold until a courier claims it", px: 64, tag: "h2", cls: "xp-band-top", element: "h2.xp-band-top",
    lines: [{ ...LINE, y: 120 }, { ...LINE, y: 190 }, { ...LINE, y: 260 }],
    clips: [{ element: "div.xp-band-top", box: { x: 100, y: 120, width: 1700, height: 140 } }],
  }],
  boxes: [{ element: "h2.xp-band-top", box: { ...LINE, y: 120, height: 210 } }, ...FULL_STAGE.boxes.slice(1)],
};

describe("qa stage motion-happened", () => {
  it("fails a beat whose frame at t and t + 0.5 are identical, reporting it by beat when no table holds its elements", async () => {
    const b2Start = 4 * RENDER_FPS;

    const { report, checks } = await harness.run({ diffAt: (n) => (n > b2Start ? 0 : 0.02) }, { timeline: TWO_BEATS });

    expect(checks["motion-happened"]).toMatchObject({ gate: true, pass: false });
    expect(report.measured.filter((f) => f.code === "motion-happened")).toEqual([
      expect.objectContaining({ beat: "b2", anchors: [], message: expect.stringMatching(/^b2: no frame changed from 4\.00 s/) }),
    ]);
    expect(report.pass).toBe(false);
  });

  it("passes when every beat moves before its settled sample", async () => {
    const { report, checks } = await harness.run({}, { timeline: TWO_BEATS });

    expect(checks["motion-happened"]).toMatchObject({ gate: true, pass: true });
    expect(report.framediff).toMatchObject({ fps: RENDER_FPS, shares: expect.any(Array) });
  });
});

describe("qa stage content-fill", () => {
  it.each([
    ["fails", "a beat drawn at a third of its scale", THIRD_SCALE, false],
    ["passes", "a beat that fills the stage", FULL_STAGE, true],
  ])("%s on %s", async (_, __, probe, pass) => {
    const { checks } = await harness.run({ probeAt: () => probe });

    expect(checks["content-fill"]).toMatchObject({ gate: true, pass });
  });
});

describe("qa stage clipped-text", () => {
  it("fails the X3 b20 headline whose third line its band cuts, anchored on the cells the headline sits on", async () => {
    const { report, checks } = await harness.run({ probeAt: () => CLIPPED_HEADLINE });

    expect(checks["clipped-text"]).toMatchObject({ gate: true, pass: false, detail: expect.stringMatching(/^1 clipped-text: \[A1,B1,C1,A2,B2,C2\] b1 /) });
    expect(report.measured.filter((f) => f.code === "clipped-text")).toEqual([
      expect.objectContaining({ beat: "b1", t: 3.5, anchors: ["A1", "B1", "C1", "A2", "B2", "C2"], message: expect.stringMatching(/^b1 h2\.xp-band-top: line 3 of 3 cut by div\.xp-band-top/) }),
    ]);
  });

  it("passes the same headline when its band holds all three lines", async () => {
    const fits: Probe = { ...CLIPPED_HEADLINE, texts: CLIPPED_HEADLINE.texts.map((text) => ({ ...text, clips: [{ element: "div.xp-band-top", box: { x: 100, y: 120, width: 1700, height: 210 } }] })) };

    const { checks } = await harness.run({ probeAt: () => fits });

    expect(checks["clipped-text"]).toMatchObject({ gate: true, pass: true });
  });
});

describe("qa stage stage-empty", () => {
  it("reports, without gating, a beat whose stage stays empty past 3 s", async () => {
    const { checks } = await harness.run({ probeAt: () => ({ texts: [], boxes: [] }) });

    expect(checks["stage-empty"]).toMatchObject({ gate: false, pass: false });
  });
});
