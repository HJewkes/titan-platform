import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CUSTOM_LAYER_ELEMENT,
  PIXEL_ELEMENT,
  buildOccupancy,
  layoutsFromScript,
  occupancyForMark,
  pixelAnchors,
  type OccupancyInput,
} from "./occupancy-table.js";
import { scriptWith } from "./script-fixtures.test-helpers.js";
import { ScriptSchema } from "./script-schema.js";

const FIXTURE = JSON.parse(readFileSync(new URL("../fixtures/anchors/marks.json", import.meta.url), "utf8")) as OccupancyInput;
const STAGE = FIXTURE.stage;
const tables = buildOccupancy(FIXTURE);
const byBeat = (beat: string) => tables.find((table) => table.beat === beat)!;

describe("buildOccupancy over the synthetic marks", () => {
  it("emits one table per settled mark, named by beat and time", () => {
    expect(tables.map((t) => t.mark)).toEqual(["b01-hook@2.5s", "b02-flow@6s", "b03-sketch@9.25s", "b04-crib@12s"]);
  });

  it("maps a template beat's DOM elements to the anchors their boxes cover", () => {
    const table = byBeat("b01-hook");
    expect(table.source).toBe("dom");
    expect(table.cells).toEqual({
      A1: ["headline"], B1: ["headline"], C1: ["headline"], D1: ["headline"], E1: ["headline"], F1: ["headline"],
      A3: ["row-1"], B3: ["row-1"], C3: ["row-1", "row-2"], D3: ["row-1", "row-2"], E3: ["row-2"], F3: ["row-2"],
    });
  });

  it("places a custom layer on the anchors it declares, alongside its DOM elements", () => {
    const table = byBeat("b02-flow");
    expect(table.source).toBe("declared");
    expect(table.cells.B2).toEqual([CUSTOM_LAYER_ELEMENT]);
    expect(table.cells.E5).toEqual([CUSTOM_LAYER_ELEMENT]);
    expect(table.cells.C6).toEqual(["caption"]);
    expect(Object.keys(table.cells)).toHaveLength(18);
  });

  it("falls back to the pixel grid for a custom layer that declares no anchors", () => {
    const table = byBeat("b03-sketch");
    expect(table.source).toBe("pixel");
    expect(table.cells).toEqual({ B2: [PIXEL_ELEMENT], C2: [PIXEL_ELEMENT], B3: [PIXEL_ELEMENT], D3: [PIXEL_ELEMENT], D4: [PIXEL_ELEMENT] });
  });

  it("keeps a beat with no layout on its DOM elements", () => {
    const table = byBeat("b04-crib");
    expect(table.source).toBe("dom");
    expect(Object.keys(table.cells)).toEqual(["C3", "D3", "C4", "D4"]);
  });
});

describe("occupancyForMark", () => {
  const mark = { beat: "b09-walk", t: 1, elements: [{ id: "label", box: { x: 0, y: 0, width: 10, height: 10 } }] };
  const pixels = { beat: "b09-walk", t: 1, coverage: [[0, 0.9]] };

  it("prefers declared anchors to the pixel grid", () => {
    const table = occupancyForMark(mark, STAGE, { beat: "b09-walk", layer: "custom", anchors: ["F6"] }, pixels);
    expect(table.source).toBe("declared");
    expect(table.cells).toEqual({ A1: ["label"], F6: [CUSTOM_LAYER_ELEMENT] });
  });

  it("does not read pixels for a template beat that has DOM elements", () => {
    const table = occupancyForMark(mark, STAGE, { beat: "b09-walk", layer: "template" }, pixels);
    expect(table.source).toBe("dom");
    expect(table.cells).toEqual({ A1: ["label"] });
  });

  it("reads pixels for a beat whose DOM shows nothing", () => {
    const table = occupancyForMark({ ...mark, elements: [] }, STAGE, undefined, pixels);
    expect(table.source).toBe("pixel");
    expect(table.cells).toEqual({ B1: [PIXEL_ELEMENT] });
  });

  it("reads pixels for an undeclared custom layer even when it has DOM labels", () => {
    const table = occupancyForMark(mark, STAGE, { beat: "b09-walk", layer: "custom" }, pixels);
    expect(table.source).toBe("pixel");
    expect(table.cells).toEqual({ A1: ["label"], B1: [PIXEL_ELEMENT] });
  });

  it("lists an element once per cell even when two of its boxes land there", () => {
    const twice = { ...mark, elements: [...mark.elements, { id: "label", box: { x: 20, y: 20, width: 5, height: 5 } }] };
    expect(occupancyForMark(twice, STAGE).cells).toEqual({ A1: ["label"] });
  });
});

describe("buildOccupancy's pixel lookup", () => {
  it("uses the pixel grid of the same beat at the same moment", () => {
    const grid = (beat: string, t: number, cell: number) => ({ beat, t, coverage: [Array.from({ length: 6 }, (_, i) => (i === cell ? 1 : 0))] });
    const built = buildOccupancy({
      stage: STAGE,
      layouts: [{ beat: "b05-art", layer: "custom" }],
      marks: [{ beat: "b05-art", t: 2, elements: [] }],
      pixels: [grid("b06-other", 2, 0), grid("b05-art", 1, 1), grid("b05-art", 2, 2)],
    });
    expect(built[0]!.cells).toEqual({ C1: [PIXEL_ELEMENT] });
  });
});

describe("pixelAnchors", () => {
  it("counts a cell at the threshold as drawn on, and one below it as empty", () => {
    expect(pixelAnchors({ beat: "b", t: 0, coverage: [[0.05, 0.049]] })).toEqual(["A1"]);
    expect(pixelAnchors({ beat: "b", t: 0, coverage: [[0.3, 0.3]] }, 0.5)).toEqual([]);
  });

  it("reads rows top to bottom", () => {
    expect(pixelAnchors({ beat: "b", t: 0, coverage: [[], [], [], [], [], [0, 0, 0, 0, 0, 1]] })).toEqual(["F6"]);
  });
});

describe("layoutsFromScript", () => {
  it("lists beats that declare a layer or anchors and skips legacy beats", () => {
    const visual = { assertion: "A drawn flow", job: "map", layer: "custom", anchors: ["A1:B2", "F6"] };
    const declared = ScriptSchema.parse(scriptWith({ visual }));
    expect(layoutsFromScript(declared)).toEqual([{ beat: "c2-1-stations", layer: "custom", anchors: ["A1:B2", "F6"] }]);
    expect(layoutsFromScript(ScriptSchema.parse(scriptWith()))).toEqual([]);
  });
});
