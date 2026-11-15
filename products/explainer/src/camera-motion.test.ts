import { describe, expect, it } from "vitest";
import { cameraMotionRows, type CameraSample } from "./camera-motion.js";

const RATE = 120;
const LIMITS = { velocity: 1, jerk: 20 };

/** Frame-sized boxes sampled at 4x a 30 fps frame rate, the centre following `x(t)`. */
function track(seconds: number, x: (t: number) => number): CameraSample[] {
  const count = Math.round(seconds * RATE) + 1;
  return Array.from({ length: count }, (_, i) => {
    const t = i / RATE;
    return { t, box: { x: x(t) * 1600, y: 0, width: 1600, height: 900 } };
  });
}

// Zero velocity and acceleration at both ends, so the move has no jerk impulse.
const smootherstep = (s: number) => s * s * s * (s * (6 * s - 15) + 10);
const rowFor = (rows: ReturnType<typeof cameraMotionRows>, name: string) => rows.find((r) => r.row === name)!;

describe("cameraMotionRows", () => {
  it("passes both rows for an eased move between two stations", () => {
    const eased = track(3, (t) => 0.5 * smootherstep(Math.min(1, Math.max(0, (t - 0.5) / 2))));

    const rows = cameraMotionRows(eased, LIMITS);

    expect(rows).toEqual([
      { row: "camera:velocity", pass: true, times: [] },
      { row: "camera:jerk", pass: true, times: [] },
    ]);
  });

  it("fails velocity at the sample where the camera teleports", () => {
    const teleport = track(1, (t) => (t >= 0.5 ? 0.5 : 0));

    const velocity = rowFor(cameraMotionRows(teleport, LIMITS), "camera:velocity");

    expect(velocity.pass).toBe(false);
    expect(velocity.times).toEqual([0.5]);
  });

  it("fails jerk for an abrupt start and stop that stays under the velocity limit", () => {
    const abrupt = track(2, (t) => 0.5 * Math.min(Math.max(t - 0.5, 0), 1));

    const rows = cameraMotionRows(abrupt, LIMITS);

    expect(rowFor(rows, "camera:velocity").pass).toBe(true);
    expect(rowFor(rows, "camera:jerk").pass).toBe(false);
  });

  it("excuses a spike inside a declared shake window", () => {
    const teleport = track(1, (t) => (t >= 0.5 ? 0.5 : 0));

    const rows = cameraMotionRows(teleport, LIMITS, [{ from: 0.45, to: 0.6 }]);

    expect(rows.map((r) => r.pass)).toEqual([true, true]);
  });
});
