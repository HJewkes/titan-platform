import { describe, expect, it } from "vitest";
import { readCameraTrack } from "./camera-track-file.js";

const file = {
  schema: "explainer.camera-track/v1",
  fps: 30,
  sampleRateMultiple: 4,
  easeName: "smootherstep",
  track: [{ t: 0, box: { x: 0, y: 0, width: 1600, height: 900 } }],
  beats: [{ beatId: "b1", startS: 0 }],
  keyBoxes: [{ id: "worker", beatId: "b1", box: { x: 10, y: 10, width: 100, height: 50 }, fromS: 0, toS: 2 }],
  reveals: [{ id: "store", beatId: "b1", box: { x: 900, y: 10, width: 100, height: 50 }, fromS: 0, atS: 1 }],
};

describe("camera track file", () => {
  it("reads a track file into the camera-path input", () => {
    const input = readCameraTrack(file);

    expect(input.track).toEqual(file.track);
    expect(input.beats).toEqual(file.beats);
    expect(input.keyBoxes).toEqual(file.keyBoxes);
    expect(input.reveals).toEqual(file.reveals);
  });

  it("a track file with an unknown field is refused", () => {
    expect(() => readCameraTrack({ ...file, zoom: 2 })).toThrow();
  });

  it("a track file with another schema id is refused", () => {
    expect(() => readCameraTrack({ ...file, schema: "explainer.camera-track/v2" })).toThrow();
  });
});
