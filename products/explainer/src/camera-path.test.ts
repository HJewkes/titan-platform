import { describe, expect, it } from "vitest";
import { CAPTION_KEEP_OUT, type Box } from "./camera.js";
import { cameraPathFromMap, cameraPathRows, loadCameraPathDoctrine, type CameraPathInput } from "./camera-path.js";
import { L0_CHECKS, runL0 } from "./eval-l0.js";
import type { MapEvent, MapSegment, MapTimeline } from "./map-timeline.js";
import { ScriptSchema } from "./script-schema.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";

// Synthetic layout units: one frame is 1600 x 900.
const W = 1600;
const H = 900;
const FPS = 30;
const frameAt = (x: number): Box => ({ x, y: 0, width: W, height: H });
const square = (x: number, y: number): Box => ({ x, y, width: 200, height: 200 });

const doctrine = loadCameraPathDoctrine();

const segment = (beatId: string, startS: number, endS: number, events: MapEvent[]): MapSegment => {
  const view = { level: "containers" as const, camera: null, revealed: [], focus: null, active: [] };
  return { beatId, startS, endS, resumed: false, minimap: false, start: view, end: view, events };
};
const cameraAt = (atS: number, id: string): MapEvent => ({ atS, kind: "camera", id });

/** A path over `segments`, each camera target named by its station's x offset in frame widths. */
function pathOf(segments: MapSegment[], layout: Record<string, Box> = {}): CameraPathInput {
  const timeline: MapTimeline = { segments };
  const cameraBox = (_beat: string, target: string) => frameAt(Number(target) * W);
  return cameraPathFromMap(timeline, { cameraBox, layoutBox: (id) => layout[id]!, fps: FPS }, doctrine);
}

const xAt = (input: CameraPathInput, t: number): number => input.track.find((s) => Math.abs(s.t - t) < 1e-9)!.box.x;
const rowOf = (input: CameraPathInput, id: string) => cameraPathRows(input, doctrine).find((r) => r.check_id === id)!;

describe("camera-path doctrine", () => {
  it("doctrine caption line equals CAPTION_KEEP_OUT", () => {
    expect(doctrine.captionTop).toBe(CAPTION_KEEP_OUT);
  });

  it("ships every row as a warning while the easing is assumed", () => {
    const severities = Object.values(doctrine.rows).map((r) => r.severity);

    expect(doctrine.easing).toEqual({ model: "smootherstep", assumed: true });
    expect(severities).toEqual(["warning", "warning", "warning", "warning"]);
  });
});

describe("camera-path track from a map timeline", () => {
  it("a camera event eases between two stations over its duration", () => {
    const input = pathOf([segment("beat-01", 0, 4, [cameraAt(0, "0"), cameraAt(2, "1")])]);

    expect([0.5, 2, 2.25, 2.5, 3, 4].map((t) => xAt(input, t))).toEqual([0, 0, 0.103515625 * W, W / 2, W, W]);
    expect(rowOf(input, "camera:velocity").pass).toBe(true);
    expect(rowOf(input, "camera:jerk").pass).toBe(true);
  });

  it("a move started mid-move eases from the current pose", () => {
    const input = pathOf([segment("beat-01", 0, 4, [cameraAt(0, "0"), cameraAt(1, "1"), cameraAt(1.5, "0")])]);

    expect([1.5, 2, 2.5].map((t) => xAt(input, t))).toEqual([W / 2, W / 4, 0]);
  });

  it("a focus box stays a key box until the beat's next focus", () => {
    const events: MapEvent[] = [
      cameraAt(4, "0"),
      { atS: 6, kind: "focus", id: "broker", ids: ["broker"] },
      { atS: 8, kind: "focus", id: "store", ids: ["store"] },
    ];
    const input = pathOf([segment("beat-02", 4, 10, events)], { broker: square(100, 100), store: square(100, 700) });

    expect(input.keyBoxes.map(({ id, fromS, toS }) => [id, fromS, toS])).toEqual([["broker", 6, 8], ["store", 8, 10]]);
    expect(rowOf(input, "camera:key-in-frame")).toMatchObject({ pass: false, detail_beats: ["beat-02"] });
  });

  it("a reveal is checked from its beat's start up to its cue", () => {
    const layout = { broker: square(300, 300) };
    const reveal: MapEvent = { atS: 5, kind: "reveal", id: "broker" };
    const heldOn = pathOf([segment("beat-01", 0, 3, [cameraAt(0, "0")]), segment("beat-02", 3, 6, [reveal])], layout);
    const leftBeforeBeat = pathOf([segment("beat-01", 0, 3, [cameraAt(0, "0"), cameraAt(2, "5")]), segment("beat-02", 3, 6, [reveal])], layout);

    expect(heldOn.reveals).toEqual([{ id: "broker", beatId: "beat-02", box: layout.broker, fromS: 3, atS: 5 }]);
    expect(rowOf(heldOn, "camera:seen-before-reveal")).toMatchObject({ pass: false, value: 1, detail_beats: ["beat-02"] });
    expect(rowOf(leftBeforeBeat, "camera:seen-before-reveal")).toMatchObject({ pass: true, value: 0 });
  });
});

describe("camera-path rows at L0", () => {
  const script = () => ScriptSchema.parse(scriptWith());
  const cameraIds = (camera?: CameraPathInput) =>
    runL0(script(), undefined, L0_CHECKS, undefined, undefined, camera).map((r) => r.check_id).filter((id) => id.startsWith("camera:"));

  it("a run with a camera track reports all four rows", () => {
    const camera = pathOf([segment("beat-01", 0, 2, [cameraAt(0, "0")])]);

    expect(cameraIds(camera)).toEqual(["camera:velocity", "camera:jerk", "camera:key-in-frame", "camera:seen-before-reveal"]);
  });

  it("a run with no track reports none", () => {
    expect(cameraIds()).toEqual([]);
  });
});
