import { interpolate, MOTION, type Easing } from "@titan-design/react-ui/motion";

/**
 * DIRECTION section 4 timing for video, which runs slower than titan-design's UI `MOTION` durations: a small move
 * takes 0.5 s and eases out, and an exit takes 0.85x its entrance. The spike's other video timings (standard and
 * camera moves, the capped stagger) arrive with the first ported beat that uses them.
 */
const SMALL_MOVE_S = 0.5;
/** A small move's exit. */
export const SMALL_EXIT_S = SMALL_MOVE_S * 0.85;

/** 0 before `atS`, eased to 1 over `durationS`. */
export function progress(t: number, atS: number, durationS: number = SMALL_MOVE_S, ease: Easing = MOTION.ease.out): number {
  return interpolate(t, [atS, atS + durationS], [0, 1], { ease });
}

/** Fade in while rising into place: the entrance every example beat uses. */
export function fadeUp(t: number, atS: number, risePx = 32, durationS: number = SMALL_MOVE_S) {
  const p = progress(t, atS, durationS);
  return { opacity: p, transform: `translateY(${(1 - p) * risePx}px)` };
}
