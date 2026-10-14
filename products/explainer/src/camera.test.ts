import { describe, expect, it } from "vitest";
import { CAPTION_KEEP_OUT, CameraStationSchema, FRAME_ASPECT, cameraStation, cameraStationFile, projectBox, type LayoutBox } from "./camera.js";

const layout: LayoutBox[] = [
  { id: "web", x: 0, y: 0, width: 160, height: 60 },
  { id: "api", x: 240, y: 40, width: 160, height: 60 },
  { id: "store", x: 240, y: 400, width: 160, height: 60 },
  { id: "wide", x: -800, y: 600, width: 2400, height: 40 },
];

const cases: [string, string[]][] = [
  ["a wide row", ["web", "api"]],
  ["a tall column", ["api", "store"]],
  ["one very wide box", ["wide"]],
  ["every box", ["web", "api", "store", "wide"]],
];

describe("cameraStation", () => {
  it.each(cases)("frames %s at 16:9 with every focus box inside and above the caption line", (_, focus) => {
    const { box: camera } = cameraStation("beat-04", layout, focus);

    expect(camera.width / camera.height).toBeCloseTo(FRAME_ASPECT, 9);
    for (const box of layout.filter((b) => focus.includes(b.id))) {
      const projected = projectBox(box, camera);
      expect(projected.x).toBeGreaterThanOrEqual(0);
      expect(projected.y).toBeGreaterThanOrEqual(0);
      expect(projected.x + projected.width).toBeLessThanOrEqual(1);
      expect(projected.y + projected.height).toBeLessThanOrEqual(CAPTION_KEEP_OUT);
    }
  });

  it("writes camera/<beat>.json with sorted focus ids, the same for any focus order", () => {
    const a = cameraStationFile(cameraStation("beat-04", layout, ["store", "api"]));
    const b = cameraStationFile(cameraStation("beat-04", layout, ["api", "store", "api"]));

    expect(a.path).toBe("camera/beat-04.json");
    expect(a.json).toBe(b.json);
    expect(CameraStationSchema.parse(JSON.parse(a.json)).focus).toEqual(["api", "store"]);
  });

  it("throws on a focus id the layout does not have, or on no focus at all", () => {
    expect(() => cameraStation("beat-04", layout, ["ghost"])).toThrow(/ghost/);
    expect(() => cameraStation("beat-04", layout, [])).toThrow(/no focus/);
  });
});
