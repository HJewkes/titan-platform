import { interpolate, MOTION, type Easing } from "@titan-design/react-ui/motion";

/**
 * DIRECTION section 4 timing for video, which runs slower than titan-design's UI `MOTION` durations: a small move
 * takes 0.5 s and eases out. The spike's other video timings (standard and camera moves, the capped stagger) arrive
 * with the first ported beat that uses them.
 */
const SMALL_MOVE_S = 0.5;

/** 0 before `atS`, eased to 1 over `durationS`. */
function progress(t: number, atS: number, durationS: number, ease: Easing = MOTION.ease.out): number {
  return interpolate(t, [atS, atS + durationS], [0, 1], { ease });
}

/** Fade in while rising into place: the one entrance every stage beat uses. */
export function fadeUp(t: number, atS: number, risePx = 32, durationS: number = SMALL_MOVE_S) {
  const p = progress(t, atS, durationS);
  return { opacity: p, transform: `translateY(${(1 - p) * risePx}px)` };
}
