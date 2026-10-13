import { describe, it, expect } from "vitest";
import { canvasOf, labelOverlaps, routeMetrics } from "./repo-map-metrics.mjs";

const box = (id, x, y) => ({ id, x, y, width: 100, height: 40 });
const routeOf = (e) => e.attrs?.route;

describe("repo map metrics", () => {
  const boxes = [box("a", 50, 20), box("b", 50, 220), box("c", 50, 120)];

  it("counts a route through a box that is not its end as a foreign cut", () => {
    const straight = { srcId: "a", dstId: "b", attrs: { route: [{ x: 50, y: 40 }, { x: 50, y: 200 }] } };
    const around = {
      srcId: "a",
      dstId: "c",
      attrs: { route: [{ x: 50, y: 40 }, { x: 50, y: 70 }, { x: 70, y: 70 }, { x: 70, y: 100 }] },
    };

    const m = routeMetrics([straight, around], boxes, routeOf);

    expect(m).toMatchObject({ routed: 2, foreignCuts: 1, maxBends: 2, meanBends: 1, upward: 0 });
  });

  it("does not count a route that runs along a box border as a cut", () => {
    const edge = { srcId: "a", dstId: "b", attrs: { route: [{ x: 0, y: 40 }, { x: 0, y: 200 }] } };
    expect(routeMetrics([edge], boxes, routeOf).foreignCuts).toBe(0);
  });

  it("counts each overlapping pair of label rectangles once", () => {
    const rects = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
      { x: 10, y: 0, width: 10, height: 4 },
    ];
    expect(labelOverlaps(rects)).toBe(1);
  });

  it("measures the canvas to the far edge of the furthest box", () => {
    expect(canvasOf(boxes)).toEqual({ width: 100, height: 240 });
  });
});
