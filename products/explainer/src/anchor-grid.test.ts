import { describe, expect, it } from "vitest";
import { ANCHOR_IDS, anchorCell, anchorRect, anchorsForBox, expandAnchors, placeSlots } from "./anchor-grid.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { ScriptSchema } from "./script-schema.js";

const STAGE = { width: 1920, height: 1080 };

describe("the 6x6 anchor grid", () => {
  it("names 36 cells from A1 at the top left to F6 at the bottom right, row by row", () => {
    expect(ANCHOR_IDS).toHaveLength(36);
    expect(ANCHOR_IDS.slice(0, 7)).toEqual(["A1", "B1", "C1", "D1", "E1", "F1", "A2"]);
    expect(ANCHOR_IDS.at(-1)).toBe("F6");
  });

  it("reads a cell id as zero-based column and row", () => {
    expect(anchorCell("A1")).toEqual({ col: 0, row: 0 });
    expect(anchorCell("D5")).toEqual({ col: 3, row: 4 });
    expect(() => anchorCell("G1")).toThrow(/A1 to F6/);
  });

  it("gives each cell a sixth of the stage on each axis", () => {
    expect(anchorRect("A1", STAGE)).toEqual({ x: 0, y: 0, width: 320, height: 180 });
    expect(anchorRect("F6", STAGE)).toEqual({ x: 1600, y: 900, width: 320, height: 180 });
    expect(anchorRect("C2", STAGE)).toEqual({ x: 640, y: 180, width: 320, height: 180 });
  });
});

describe("anchorsForBox", () => {
  it("returns the one cell a box sits inside", () => {
    expect(anchorsForBox({ x: 10, y: 10, width: 100, height: 100 }, STAGE)).toEqual(["A1"]);
  });

  it("returns every cell a box overlaps, row by row", () => {
    expect(anchorsForBox({ x: 300, y: 170, width: 400, height: 20 }, STAGE)).toEqual(["A1", "B1", "C1", "A2", "B2", "C2"]);
  });

  it("does not count a box that only touches a cell's edge", () => {
    expect(anchorsForBox({ x: 320, y: 180, width: 320, height: 180 }, STAGE)).toEqual(["B2"]);
  });

  it("clips a box that runs off the stage and drops one wholly off it", () => {
    expect(anchorsForBox({ x: 1800, y: 1000, width: 400, height: 400 }, STAGE)).toEqual(["F6"]);
    expect(anchorsForBox({ x: -500, y: 0, width: 100, height: 100 }, STAGE)).toEqual([]);
    expect(anchorsForBox({ x: 1920, y: 0, width: 100, height: 100 }, STAGE)).toEqual([]);
  });

  it("drops an empty box", () => {
    expect(anchorsForBox({ x: 100, y: 100, width: 0, height: 50 }, STAGE)).toEqual([]);
  });

  it("covers the whole grid for a full-stage box", () => {
    expect(anchorsForBox({ x: 0, y: 0, width: 1920, height: 1080 }, STAGE)).toEqual(ANCHOR_IDS);
  });
});

describe("expandAnchors", () => {
  it("expands a range to its rectangle in either corner order", () => {
    expect(expandAnchors(["B2:C3"])).toEqual(["B2", "C2", "B3", "C3"]);
    expect(expandAnchors(["C3:B2"])).toEqual(["B2", "C2", "B3", "C3"]);
  });

  it("keeps single cells, dedupes overlaps and sorts row by row", () => {
    expect(expandAnchors(["F1", "A1:B1", "B1"])).toEqual(["A1", "B1", "F1"]);
  });

  it("rejects a cell outside the grid", () => {
    expect(() => expandAnchors(["A1:A7"])).toThrow(/A1 to F6/);
  });
});

describe("placeSlots", () => {
  it("addresses each template slot by its anchors", () => {
    const placed = placeSlots({ title: "A1:F1", left: "A2:C6", right: ["D2:F4", "D6"] });
    expect(placed).toEqual({
      title: ["A1", "B1", "C1", "D1", "E1", "F1"],
      left: ["A2", "B2", "C2", "A3", "B3", "C3", "A4", "B4", "C4", "A5", "B5", "C5", "A6", "B6", "C6"],
      right: ["D2", "E2", "F2", "D3", "E3", "F3", "D4", "E4", "F4", "D6"],
    });
  });
});

describe("script/v1 anchors", () => {
  const parse = (anchors: string[]) =>
    ScriptSchema.safeParse(scriptWith({ visual: { assertion: "A drawn flow", job: "map", layer: "custom", anchors } })).success;

  it("take a cell or a range, and expand to the cells the occupancy table uses", () => {
    expect(parse(["B2:E5", "F6"])).toBe(true);
    expect(expandAnchors(["B2:E5", "F6"])).toHaveLength(17);
  });

  it("reject a range off the grid or a malformed one", () => {
    expect(parse(["B2:G5"])).toBe(false);
    expect(parse(["B2:"])).toBe(false);
    expect(parse(["B2:C3:D4"])).toBe(false);
  });
});

describe("expandAnchors on malformed ranges", () => {
  it("rejects a range of three corners", () => {
    expect(() => expandAnchors(["A1:B2:C3"])).toThrow(/two joined/);
  });
});
