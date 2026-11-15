import type { Box } from "./camera.js";

export const EASING_NAMES = ["linear", "smoothstep", "smootherstep"] as const;
export type Easing = (typeof EASING_NAMES)[number];

const EASINGS: Record<Easing, (u: number) => number> = {
  linear: (u) => u,
  smoothstep: (u) => u * u * (3 - 2 * u),
  smootherstep: (u) => u * u * u * (u * (6 * u - 15) + 10),
};

/** One camera move in a resolved track: the camera eases to `box` over `durS` from wherever it is at `atS`. */
export interface CameraKey {
  beatId: string;
  atS: number;
  durS: number;
  box: Box;
}

interface Move {
  key: CameraKey;
  from: Box;
}

/** A sampled moment's speed or jerk, screen-relative, with the beat whose move was running. */
export interface MotionSample {
  atS: number;
  beatId: string;
  value: number;
}

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
const lerpBox = (a: Box, b: Box, k: number): Box => ({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), width: lerp(a.width, b.width, k), height: lerp(a.height, b.height, k) });

function activeMove(moves: readonly Move[], t: number): Move {
  let found = moves[0]!;
  for (const move of moves) if (move.key.atS <= t) found = move;
  return found;
}

function boxAt(moves: readonly Move[], t: number, ease: (u: number) => number): Box {
  const { key, from } = activeMove(moves, t);
  const elapsed = t - key.atS;
  if (key.durS <= 0 || elapsed >= key.durS) return key.box;
  return lerpBox(from, key.box, ease(Math.max(0, elapsed) / key.durS));
}

/** The camera's box at any time. The first key is the opening frame; a key that starts mid-move interrupts it. */
export function cameraTrack(keys: readonly CameraKey[], easing: Easing): { boxAt: (t: number) => Box; beatAt: (t: number) => string } {
  if (keys.length === 0) throw new Error("a camera track needs at least one key");
  const ease = EASINGS[easing];
  const sorted = [...keys].sort((a, b) => a.atS - b.atS);
  const moves: Move[] = [{ key: { ...sorted[0]!, durS: 0 }, from: sorted[0]!.box }];
  for (const key of sorted.slice(1)) moves.push({ key, from: boxAt(moves, key.atS, ease) });
  return { boxAt: (t) => boxAt(moves, t, ease), beatAt: (t) => activeMove(moves, t).key.beatId };
}

type Vec = readonly [number, number, number];

const sub = (a: Vec, b: Vec, scale: number): Vec => [(a[0] - b[0]) * scale, (a[1] - b[1]) * scale, (a[2] - b[2]) * scale];
const norm = (v: Vec): number => Math.hypot(...v);

/** The velocity between two boxes a sample apart: pan in frame widths, zoom in log width, per second. */
function velocity(a: Box, b: Box, hz: number): Vec {
  const width = (a.width + b.width) / 2;
  const centre = (box: Box): [number, number] => [box.x + box.width / 2, box.y + box.height / 2];
  const [ax, ay] = centre(a);
  const [bx, by] = centre(b);
  return [((bx - ax) / width) * hz, ((by - ay) / width) * hz, Math.log(b.width / a.width) * hz];
}

/** Times from three samples before the first key to three after the last move ends, so a hard start or stop is seen. */
function sampleTimes(keys: readonly CameraKey[], hz: number): number[] {
  const start = Math.min(...keys.map((key) => key.atS)) - 3 / hz;
  const end = Math.max(...keys.map((key) => key.atS + key.durS)) + 3 / hz;
  return Array.from({ length: Math.ceil((end - start) * hz) + 1 }, (_, i) => start + i / hz);
}

/**
 * Speed and jerk at every sample of the track. Each value is stamped with its stencil's last sample, so a spike at a
 * move's first instant belongs to that move's beat rather than the one before.
 */
export function cameraMotion(keys: readonly CameraKey[], easing: Easing, hz: number): { speed: MotionSample[]; jerk: MotionSample[] } {
  const track = cameraTrack(keys, easing);
  const times = sampleTimes(keys, hz);
  const boxes = times.map(track.boxAt);
  const v = boxes.slice(1).map((box, i) => velocity(boxes[i]!, box, hz));
  const a = v.slice(1).map((vi, i) => sub(vi, v[i]!, hz));
  const j = a.slice(1).map((ai, i) => sub(ai, a[i]!, hz));
  const stamp = (span: number) => (value: number, i: number): MotionSample => ({ atS: times[i + span]!, beatId: track.beatAt(times[i + span]!), value });
  return { speed: v.map(norm).map(stamp(1)), jerk: j.map(norm).map(stamp(3)) };
}
