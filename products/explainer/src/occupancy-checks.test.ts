import { describe, expect, it } from "vitest";
import { attributeFindings } from "./attribute.js";
import { anchorFindings, collisions, elementAnchors, emptySpace, formatAnchoredFinding, type QaFinding } from "./occupancy-checks.js";
import { buildOccupancy, type OccupancyTable } from "./occupancy-table.js";
import { marksFixture } from "./occupancy-fixtures.test-helpers.js";

const FIXTURE = marksFixture();
const tables = buildOccupancy(FIXTURE);
const byBeat = (beat: string) => tables.find((table) => table.beat === beat)!;
const table = (cells: OccupancyTable["cells"], beat = "beat-03", t = 4): OccupancyTable => ({ mark: `${beat}@${t}s`, beat, t, source: "dom", cells });

describe("collisions", () => {
  it("lists the cells two elements share", () => {
    expect(collisions(byBeat("b01-hook"))).toEqual([
      { anchor: "C3", elements: ["row-1", "row-2"] },
      { anchor: "D3", elements: ["row-1", "row-2"] },
    ]);
  });

  it("finds none where each cell holds one element", () => {
    expect(collisions(byBeat("b04-crib"))).toEqual([]);
  });

  it("reports a custom layer's caption over its declared area as a collision only where they meet", () => {
    expect(collisions(table({ C5: ["custom-layer", "caption"], C6: ["caption"] }))).toEqual([{ anchor: "C5", elements: ["custom-layer", "caption"] }]);
  });
});

describe("emptySpace", () => {
  it("measures a sparse crib card as 4 of 36 cells", () => {
    const space = emptySpace(byBeat("b04-crib"));
    expect(space.coverage).toBeCloseTo(4 / 36);
    expect(space.empty).toHaveLength(32);
    expect(space.empty).not.toContain("C3");
  });

  it("counts a declared custom layer as covering its cells, so line art is not read as empty", () => {
    expect(emptySpace(byBeat("b02-flow")).coverage).toBeCloseTo(18 / 36);
  });

  it("treats a cell listed with no elements as empty", () => {
    expect(emptySpace(table({ A1: [], B1: ["x"] }))).toEqual({ empty: expect.not.arrayContaining(["B1"]), coverage: 1 / 36 });
  });
});

describe("elementAnchors", () => {
  it("gives the cells one element sits on", () => {
    expect(elementAnchors(byBeat("b01-hook"), "row-2")).toEqual(["C3", "D3", "E3", "F3"]);
    expect(elementAnchors(byBeat("b01-hook"), "missing")).toEqual([]);
  });
});

describe("anchorFindings", () => {
  const overlap: QaFinding = { code: "overlap", message: "row-1 overlaps row-2", severity: "error", beat: "b01-hook", t: 3, elements: ["row-2"] };

  it("reports a finding on its elements' anchors and the mark it was read at", () => {
    const [found] = anchorFindings([overlap], tables, FIXTURE.stage);
    expect(found).toEqual({
      code: "overlap",
      message: "row-1 overlaps row-2",
      severity: "error",
      selector: "b01-hook",
      beat: "b01-hook",
      mark: "b01-hook@2.5s",
      anchors: ["C3", "D3", "E3", "F3"],
    });
  });

  it("falls back to the finding's box when the table does not hold its elements", () => {
    const clipped: QaFinding = { code: "clip", message: "text clipped", severity: "warning", beat: "b04-crib", box: { x: 1800, y: 10, width: 50, height: 50 } };
    expect(anchorFindings([clipped], tables, FIXTURE.stage)[0]).toMatchObject({ anchors: ["F1"], mark: "b04-crib@12s" });
  });

  it("keeps a finding with nothing to place, with no anchors and no mark when its beat has no table", () => {
    const loose: QaFinding = { code: "late-fill", message: "late", severity: "error", beat: "b99-none", selector: "#stage" };
    expect(anchorFindings([loose], tables, FIXTURE.stage)[0]).toMatchObject({ anchors: [], mark: undefined, selector: "#stage" });
  });

  it("picks the beat's last table at or before the finding's moment", () => {
    const early = table({ A1: ["x"] }, "beat-03", 1);
    const late = table({ F6: ["x"] }, "beat-03", 5);
    const at = (t?: number) => anchorFindings([{ code: "c", message: "m", severity: "error", beat: "beat-03", t, elements: ["x"] }], [early, late], FIXTURE.stage)[0]!;
    expect(at(4).anchors).toEqual(["A1"]);
    expect(at(5).anchors).toEqual(["F6"]);
    expect(at(0.5).anchors).toEqual(["A1"]);
    expect(at(undefined).anchors).toEqual(["F6"]);
  });

  it("keeps the beat in the selector so repair attribution still finds it", () => {
    const finding: QaFinding = { code: "overlap", message: "cards overlap", severity: "error", beat: "beat-03", elements: ["x"] };
    const anchored = anchorFindings([finding], [table({ B2: ["x"] })], FIXTURE.stage);
    expect(attributeFindings(anchored, ["beat-03"]).byBeat.get("beat-03")).toHaveLength(1);
  });
});

describe("formatAnchoredFinding", () => {
  it("leads with the beat and its anchors", () => {
    expect(formatAnchoredFinding({ code: "c", message: "rows overlap", severity: "error", beat: "b01-hook", anchors: ["C3", "D3"] })).toBe("b01-hook C3,D3: rows overlap");
    expect(formatAnchoredFinding({ code: "c", message: "late", severity: "error", beat: "b01-hook", anchors: [] })).toBe("b01-hook: late");
  });
});
