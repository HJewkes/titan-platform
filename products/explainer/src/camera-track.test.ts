import { describe, expect, it } from "vitest";
import type { CameraSample } from "./camera.js";
import { keyBoxRows, revealRows } from "./camera-framing.js";
import { cameraMotionRows } from "./camera-motion.js";

const FRAME = { x: 0, y: 0, width: 1600, height: 900 };

describe("one camera sample track", () => {
  it("one sampled track feeds both motion and framing rows", () => {
    const track: CameraSample[] = [
      { t: 0, box: FRAME },
      { t: 1, box: FRAME },
      { t: 2, box: { ...FRAME, x: 1500 } },
      { t: 3, box: { ...FRAME, x: 1500 } },
    ];
    const reveal = { id: "db", box: { x: 2000, y: 100, width: 300, height: 200 }, atS: 4 };
    const key = { id: "api", box: { x: 400, y: 200, width: 400, height: 200 }, fromS: 0, toS: 1 };

    const motion = cameraMotionRows(track, { velocity: 0.5, jerk: 1000 });
    const revealed = revealRows(track, [reveal]);
    const keyed = keyBoxRows(track, [key]);

    expect(motion[0]).toEqual({ row: "camera:velocity", pass: false, times: [2] });
    expect(revealed).toEqual([
      { rule: "camera:seen-before-reveal", t: 2, id: "db" },
      { rule: "camera:seen-before-reveal", t: 3, id: "db" },
    ]);
    expect(keyed).toEqual([]);
  });
});
