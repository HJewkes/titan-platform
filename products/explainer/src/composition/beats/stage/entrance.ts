import { interpolate, MOTION, type Easing } from "@titan-design/react-ui/motion";

/** 0 before `atS`, eased to 1 over `durationS`: the preset beats' clock, on MOTION's slow duration by default. */
export function progressAt(t: number, atS: number, durationS: number = MOTION.duration.slow, ease: Easing = MOTION.ease.out): number {
  return interpolate(t, [atS, atS + durationS], [0, 1], { ease });
}

/**
 * Rise `risePx` into place from `atS`, uncovered top to bottom: the preset beats' entrance (title, outro). Text keeps
 * full colour while it shows, because a fade passes through colours under the 3:1 contrast floor qa holds every frame to.
 */
export function enter(t: number, atS: number, risePx = 24) {
  const p = progressAt(t, atS);
  const rising = p < 1 ? { clipPath: `inset(0 0 ${(1 - p) * 100}% 0)` } : {};
  return { opacity: p > 0 ? 1 : 0, ...rising, transform: `translateY(${(1 - p) * risePx}px)` };
}
