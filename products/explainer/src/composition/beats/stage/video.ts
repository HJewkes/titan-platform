import { interpolate, MOTION, type Easing } from "@titan-design/react-ui/motion";
import { rise } from "./entrance.js";
import { SMALL_MOVE_S } from "./video-timing.js";

export { FLOW_DWELL_S, SMALL_MOVE_S } from "./video-timing.js";

/** A small move's exit. */
export const SMALL_EXIT_S = SMALL_MOVE_S * 0.85;

/** 0 before `atS`, eased to 1 over `durationS`. */
export function progress(t: number, atS: number, durationS: number = SMALL_MOVE_S, ease: Easing = MOTION.ease.out): number {
  return interpolate(t, [atS, atS + durationS], [0, 1], { ease });
}

/** Rise into place at full colour: the entrance every example beat uses. */
export function fadeUp(t: number, atS: number, risePx = 32, durationS: number = SMALL_MOVE_S) {
  return rise(progress(t, atS, durationS), risePx);
}

/** Blend between two CSS colours by `p` (0 = from, 1 = to). */
export function mix(from: string, to: string, p: number): string {
  return `color-mix(in srgb, ${to} ${Math.round(p * 100)}%, ${from})`;
}
