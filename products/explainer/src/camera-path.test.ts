import { describe, expect, it } from "vitest";
import { CAPTION_KEEP_OUT, type Box } from "./camera.js";
import type { CameraKey } from "./camera-motion.js";
import { cameraPathFromMap, cameraPathRows, loadCameraPathDoctrine, type CameraPathInput } from "./camera-path.js";
import { L0_CHECKS, runL0 } from "./eval-l0.js";
import type { MapSegment, MapTimeline } from "./map-timeline.js";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

// Synthetic layout units: one frame is 1600 x 900.
const W = 1600;
const H = 900;
const frameAt = (x: number, y = 0): Box => ({ x, y, width: W, height: H });
const key = (beatId: string, atS: number, box: Box, durS = 1): CameraKey => ({ beatId, atS, durS, box });
const box = (x: number, y: number, size = 200): Box => ({ x, y, width: size, height: size });

const doctrine = loadCameraPathDoctrine();
const track = (input: Partial<CameraPathInput>): CameraPathInput => ({ keys: [key("beat-01", 0, frameAt(0))], keyBoxes: [], reveals: [], ...input });
const row = (input: CameraPathInput, id: string, config = doctrine) => cameraPathRows(input, config).find((r) => r.check_id === `camera:${id}`);

describe("camera-path doctrine", () => {
  it("ships every row as a warning, with the caption strip where the camera fits boxes above", () => {
    const { rows, captionTop } = doctrine;

    expect(Object.values(rows).map((r) => r.severity)).toEqual(["warning", "warning", "warning", "warning"]);
    expect(captionTop).toBe(CAPTION_KEEP_OUT);
  });
});

describe("camera-path velocity", () => {
  it("passes a one-second move across one frame width", () => {
    const input = track({ keys: [key("beat-01", 0, frameAt(0)), key("beat-02", 1, frameAt(W))] });

    const velocity = row(input, "velocity");

    expect(velocity).toMatchObject({ pass: true, severity: "warning", threshold: 2, detail_beats: [] });
    expect(velocity?.value).toBeCloseTo(1.88, 1);
  });

  it("flags the beat whose one-second move crosses three frame widths", () => {
    const input = track({ keys: [key("beat-01", 0, frameAt(0)), key("beat-02", 1, frameAt(W)), key("beat-03", 3, frameAt(4 * W))] });

    const velocity = row(input, "velocity");

    expect(velocity).toMatchObject({ pass: false, detail_beats: ["beat-03"] });
    expect(velocity?.value).toBeGreaterThan(5);
  });

  it("reads a zoom by its log width, so halving the width in a second is under the limit", () => {
    const input = track({ keys: [key("beat-01", 0, frameAt(0)), key("beat-02", 1, { x: W / 4, y: H / 4, width: W / 2, height: H / 2 })] });

    expect(row(input, "velocity")).toMatchObject({ pass: true });
  });
});

describe("camera-path jerk", () => {
  it("passes a smooth move from rest to rest", () => {
    const input = track({ keys: [key("beat-01", 0, frameAt(0)), key("beat-02", 1, frameAt(W))] });

    expect(row(input, "jerk")).toMatchObject({ pass: true, threshold: 100, detail_beats: [] });
  });

  it("flags the beat whose key interrupts a move at full speed", () => {
    const input = track({ keys: [key("beat-01", 0, frameAt(0)), key("beat-02", 1, frameAt(W)), key("beat-03", 1.5, frameAt(0))] });

    const jerk = row(input, "jerk");

    expect(jerk).toMatchObject({ pass: false, detail_beats: ["beat-03"] });
  });

  it("flags the hard start of a linear move, which the eased move hides", () => {
    const input = track({ keys: [key("beat-01", 0, frameAt(0)), key("beat-02", 1, frameAt(W / 2))] });

    const jerk = row(input, "jerk", { ...doctrine, easing: "linear" });

    expect(jerk).toMatchObject({ pass: false, detail_beats: ["beat-02"] });
  });
});

describe("camera-path key boxes", () => {
  it("passes a key box held in frame and above the captions for its whole window", () => {
    const input = track({ keyBoxes: [{ id: "store", beatId: "beat-01", startS: 0, endS: 4, box: box(100, 100) }] });

    expect(row(input, "key-in-frame")).toMatchObject({ pass: true, value: 0, threshold: 0 });
  });

  it("flags a key box that sits in the caption strip", () => {
    const input = track({ keyBoxes: [{ id: "store", beatId: "beat-01", startS: 0, endS: 4, box: box(100, 700) }] });

    expect(row(input, "key-in-frame")).toMatchObject({ pass: false, value: 1, detail_beats: ["beat-01"] });
  });

  it("flags a key box the camera pans away from before its window ends, but not one whose window ends first", () => {
    const keys = [key("beat-01", 0, frameAt(0)), key("beat-02", 2, frameAt(W))];
    const held = { id: "store", beatId: "beat-01", startS: 0, endS: 2, box: box(100, 100) };
    const left = { ...held, id: "queue", beatId: "beat-02", endS: 4 };

    const result = row(track({ keys, keyBoxes: [held, left] }), "key-in-frame");

    expect(result).toMatchObject({ pass: false, value: 1, detail_beats: ["beat-02"] });
  });
});

describe("camera-path reveals", () => {
  const object = box(W * 5 + 700, 300);

  it("passes a reveal the camera reaches only on its cue", () => {
    const input = track({ keys: [key("beat-01", 0, frameAt(0)), key("beat-02", 2, frameAt(W * 5))], reveals: [{ id: "broker", beatId: "beat-02", fromS: 1, atS: 2, box: object }] });

    expect(row(input, "reveal-early")).toMatchObject({ pass: true, value: 0 });
  });

  it("flags a reveal the camera holds whole in frame before its cue", () => {
    const input = track({ keys: [key("beat-01", 0, frameAt(0)), key("beat-02", 0.5, frameAt(W * 5))], reveals: [{ id: "broker", beatId: "beat-02", fromS: 1, atS: 2, box: object }] });

    expect(row(input, "reveal-early")).toMatchObject({ pass: false, value: 1, detail_beats: ["beat-02"] });
  });

  it("passes a reveal only partly in frame before its cue", () => {
    const halfIn = box(W - 100, 300);
    const input = track({ reveals: [{ id: "broker", beatId: "beat-01", fromS: 0, atS: 2, box: halfIn }] });

    expect(row(input, "reveal-early")).toMatchObject({ pass: true });
  });
});

const segment = (over: Partial<MapSegment>): MapSegment => {
  const view = { level: "containers" as const, camera: null, revealed: [], focus: null, active: [] };
  return { beatId: "beat-01", startS: 0, endS: 6, resumed: false, minimap: false, start: view, end: view, events: [], ...over };
};

describe("camera-path input from a compiled map track", () => {
  it("makes camera events keys, holds each focus until the beat's next focus, and checks reveals from the beat's start", () => {
    const timeline: MapTimeline = {
      segments: [
        segment({ beatId: "beat-02", startS: 4, endS: 10, events: [
          { atS: 4.5, kind: "camera", id: "s1" },
          { atS: 5, kind: "reveal", id: "broker" },
          { atS: 6, kind: "focus", id: "broker", ids: ["broker"] },
          { atS: 8, kind: "focus", id: "store", ids: ["store"] },
        ] }),
      ],
    };
    const resolvers = { cameraBox: () => frameAt(0), layoutBox: () => box(10, 10) };

    const input = cameraPathFromMap(timeline, resolvers);

    expect(input.keys).toEqual([{ beatId: "beat-02", atS: 4.5, durS: 1, box: frameAt(0) }]);
    expect(input.keyBoxes.map(({ id, startS, endS }) => [id, startS, endS])).toEqual([["broker", 6, 8], ["store", 8, 10]]);
    expect(input.reveals).toEqual([{ id: "broker", beatId: "beat-02", fromS: 4, atS: 5, box: box(10, 10) }]);
  });
});

describe("camera-path rows at L0", () => {
  const script = () => ScriptSchema.parse(scriptWith());
  const cameraIds = (camera?: CameraPathInput) => runL0(script(), undefined, L0_CHECKS, undefined, undefined, camera).map((r) => r.check_id).filter((id) => id.startsWith("camera:"));

  it("reports all four rows for a run with a camera track", () => {
    expect(cameraIds(track({}))).toEqual(["camera:velocity", "camera:jerk", "camera:key-in-frame", "camera:reveal-early"]);
  });

  it("skips them for a run with no camera track", () => {
    expect(cameraIds()).toEqual([]);
  });
});
