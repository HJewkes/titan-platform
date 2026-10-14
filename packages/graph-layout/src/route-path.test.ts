import { describe, it, expect } from "vitest";
import { routeToPathD } from "./route-path.js";

describe("routeToPathD", () => {
  it("moves to the first point and draws a line to each later point once", () => {
    const route = [
      { x: 248, y: 730 },
      { x: 248, y: 755 },
      { x: 318, y: 755 },
      { x: 318, y: 830.5 },
    ];

    expect(routeToPathD(route)).toBe("M248 730 L248 755 L318 755 L318 830.5");
  });

  it("gives an empty path for an empty route", () => {
    expect(routeToPathD([])).toBe("");
  });
});
