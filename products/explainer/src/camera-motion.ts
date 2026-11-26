import type { CameraSample } from "./camera.js";

export interface CameraMotionLimits {
  /** Frame-normalised centre or zoom speed, per second. */
  velocity: number;
  /** Frame-normalised change of that speed's rate, per second cubed. */
  jerk: number;
}

export interface ShakeWindow {
  from: number;
  to: number;
}

export interface CameraMotionRow {
  row: "camera:velocity" | "camera:jerk";
  pass: boolean;
  times: number[];
}

interface Pose {
  x: number;
  y: number;
  zoom: number;
}

// Centre is measured in widths and heights of the first box, so a pan costs the same at any zoom; zoom is the log of the width.
function poses(track: readonly CameraSample[]): Pose[] {
  const ref = track[0]!.box;
  return track.map(({ box }) => ({
    x: (box.x + box.width / 2) / ref.width,
    y: (box.y + box.height / 2) / ref.height,
    zoom: Math.log(box.width / ref.width),
  }));
}

/** The order-th finite difference of each channel at sample i, per second to that order. */
function derivative(series: readonly Pose[], track: readonly CameraSample[], i: number, order: number): number {
  const window = series.slice(i - order, i + 1);
  const dt = (track[i]!.t - track[i - order]!.t) / order;
  const diff = (pick: (p: Pose) => number) => {
    let values = window.map(pick);
    for (let k = 0; k < order; k++) values = values.slice(1).map((v, j) => v - values[j]!);
    return values[0]! / dt ** order;
  };
  return Math.max(Math.hypot(diff((p) => p.x), diff((p) => p.y)), Math.abs(diff((p) => p.zoom)));
}

function spikeTimes(track: readonly CameraSample[], order: number, limit: number, shakes: readonly ShakeWindow[]): number[] {
  const series = poses(track);
  const times: number[] = [];
  for (let i = order; i < track.length; i++) {
    const t = track[i]!.t;
    // A difference reads samples i-order..i, so a shake edge inside that span contaminates it.
    const windowStart = track[i - order]!.t;
    if (shakes.some((s) => t >= s.from && windowStart <= s.to)) continue;
    if (derivative(series, track, i, order) > limit) times.push(t);
  }
  return times;
}

/** Velocity and jerk rows over a track sampled at 4x the frame rate; a time whose finite-difference window overlaps a declared shake window is excused. */
export function cameraMotionRows(track: readonly CameraSample[], limits: CameraMotionLimits, shakes: readonly ShakeWindow[] = []): CameraMotionRow[] {
  const velocity = track.length > 1 ? spikeTimes(track, 1, limits.velocity, shakes) : [];
  const jerk = track.length > 3 ? spikeTimes(track, 3, limits.jerk, shakes) : [];
  return [
    { row: "camera:velocity", pass: velocity.length === 0, times: velocity },
    { row: "camera:jerk", pass: jerk.length === 0, times: jerk },
  ];
}
