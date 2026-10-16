import type { Point } from "./types.js";

/** An SVG path `d` through every route point in order: `M x y L x y …`, or "" for an empty route. */
export function routeToPathD(route: readonly Point[]): string {
  return route.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
}
