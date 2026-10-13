import type { GraphEdge } from "@titan-design/code-graph";
import type { Point } from "./types.js";

function isPoint(value: unknown): value is Point {
  return (
    typeof value === "object" &&
    value !== null &&
    "x" in value &&
    "y" in value &&
    typeof value.x === "number" &&
    typeof value.y === "number"
  );
}

/** The route a layout attached to `edge.attrs.route`, or undefined when the edge has none. */
export function routeOf(edge: GraphEdge): Point[] | undefined {
  const route = edge.attrs?.route;
  return Array.isArray(route) && route.every(isPoint) ? route : undefined;
}
