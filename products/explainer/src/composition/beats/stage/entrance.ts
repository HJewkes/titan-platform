import { interpolate, MOTION, type Easing } from "@titan-design/react-ui/motion";

/** 0 before `atS`, eased to 1 over `durationS`: the preset beats' clock, on MOTION's slow duration by default. */
export function progressAt(t: number, atS: number, durationS: number = MOTION.duration.slow, ease: Easing = MOTION.ease.out): number {
  return interpolate(t, [atS, atS + durationS], [0, 1], { ease });
}

/** Fade in while rising `risePx` into place, starting at `atS`: the preset beats' entrance (title, outro). */
export function enter(t: number, atS: number, risePx = 24) {
  const p = progressAt(t, atS);
  return { opacity: p, transform: `translateY(${(1 - p) * risePx}px)` };
}
