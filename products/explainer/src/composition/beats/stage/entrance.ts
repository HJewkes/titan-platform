import { interpolate, MOTION } from "@titan-design/react-ui/motion";

/** Fade in while rising `risePx` into place, starting at `atS`: the preset beats' entrance (title, outro). */
export function enter(t: number, atS: number, risePx = 24) {
  const p = interpolate(t, [atS, atS + MOTION.duration.slow], [0, 1], { ease: MOTION.ease.out });
  return { opacity: p, transform: `translateY(${(1 - p) * risePx}px)` };
}
