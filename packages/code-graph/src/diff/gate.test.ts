import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../types.js";
import { computeFootprints, type FootprintUnit } from "./footprint.js";
import { gateUnits, unitProvenance, type UnitProvenance } from "./gate.js";

const PARSE = "file:src/parse.ts#parse";
const FORMAT = "file:src/parse.ts#format";
const RENDER = "file:src/render.ts#render";

const PARSE_UNIT: FootprintUnit = { unitId: "file:src/parse.ts", symbolIds: [PARSE, FORMAT] };
const RENDER_UNIT: FootprintUnit = { unitId: "file:src/render.ts", symbolIds: [RENDER] };

function symbol(id: string, signature = `function ${id.split("#")[1]}(): void`): GraphNode {
  return { id, kind: "symbol", name: id.split("#")[1]!, parentId: id.split("#")[0], attrs: { exported: true, signature } };
}

const EDGES: GraphEdge[] = [
  { srcId: "file:src/a.ts", dstId: PARSE, kind: "references" },
  { srcId: "file:src/b.ts", dstId: RENDER, kind: "references" },
];

function footprints(nodes: GraphNode[] = [symbol(PARSE), symbol(FORMAT), symbol(RENDER)]) {
  return computeFootprints({ nodes, edges: EDGES });
}

function priorFor(units: FootprintUnit[]): UnitProvenance[] {
  const fps = footprints();
  return units.map((unit) => unitProvenance({ unit, footprints: fps, snapshot: { commitHash: "a1" }, model: "m" }));
}

describe("gateUnits", () => {
  it("regenerates nothing when every unit's hash equals its prior hash", () => {
    const prior = priorFor([PARSE_UNIT, RENDER_UNIT]);

    const result = gateUnits({ prior, units: [PARSE_UNIT, RENDER_UNIT], footprints: footprints() });

    expect(result).toEqual({ regenerate: [], skip: [PARSE_UNIT.unitId, RENDER_UNIT.unitId], orphaned: [] });
  });

  it("regenerates only the unit holding a changed symbol, as changed", () => {
    const prior = priorFor([PARSE_UNIT, RENDER_UNIT]);
    const edited = footprints([symbol(PARSE), symbol(FORMAT, "function format(x: number): string"), symbol(RENDER)]);

    const result = gateUnits({ prior, units: [PARSE_UNIT, RENDER_UNIT], footprints: edited });

    expect(result.regenerate).toEqual([{ unitId: PARSE_UNIT.unitId, reason: "changed" }]);
    expect(result.skip).toEqual([RENDER_UNIT.unitId]);
  });

  it("marks a unit with no prior record as new", () => {
    const prior = priorFor([PARSE_UNIT]);

    const result = gateUnits({ prior, units: [PARSE_UNIT, RENDER_UNIT], footprints: footprints() });

    expect(result.regenerate).toEqual([{ unitId: RENDER_UNIT.unitId, reason: "new" }]);
    expect(result.skip).toEqual([PARSE_UNIT.unitId]);
  });

  it("reports a prior unit that no longer exists as orphaned", () => {
    const prior = priorFor([PARSE_UNIT, RENDER_UNIT]);

    const result = gateUnits({ prior, units: [PARSE_UNIT], footprints: footprints() });

    expect(result).toEqual({ regenerate: [], skip: [PARSE_UNIT.unitId], orphaned: [RENDER_UNIT.unitId] });
  });
});

describe("gateUnits with repeated ids", () => {
  const [current] = priorFor([PARSE_UNIT]);
  const stale: UnitProvenance = { ...current!, symbolSetHash: "stale" };

  it("lets the last prior record for an id win, so a stale one before a current one skips", () => {
    const result = gateUnits({ prior: [stale, current!], units: [PARSE_UNIT], footprints: footprints() });

    expect(result).toEqual({ regenerate: [], skip: [PARSE_UNIT.unitId], orphaned: [] });
  });

  it("lets the last prior record for an id win, so a stale one after a current one regenerates", () => {
    const result = gateUnits({ prior: [current!, stale], units: [PARSE_UNIT], footprints: footprints() });

    expect(result.regenerate).toEqual([{ unitId: PARSE_UNIT.unitId, reason: "changed" }]);
    expect(result.skip).toEqual([]);
  });

  it("gates each occurrence of a duplicated unit id on its own", () => {
    const result = gateUnits({ prior: [current!], units: [PARSE_UNIT, PARSE_UNIT], footprints: footprints() });

    expect(result).toEqual({ regenerate: [], skip: [PARSE_UNIT.unitId, PARSE_UNIT.unitId], orphaned: [] });
  });
});

describe("unitProvenance", () => {
  it("emits the to-snapshot commit hash and the unit's symbol-set hash", () => {
    const record = unitProvenance({ unit: RENDER_UNIT, footprints: footprints(), snapshot: { commitHash: "c0ffee" } });

    expect(record.commit).toBe("c0ffee");
    expect(record.model).toBeNull();
    expect(record.unitId).toBe(RENDER_UNIT.unitId);
    expect(record.symbolSetHash).toBe(priorFor([RENDER_UNIT])[0]!.symbolSetHash);
  });

  it("records the model it is given", () => {
    expect(priorFor([RENDER_UNIT])[0]!.model).toBe("m");
  });

  it("emits a null commit for a working-tree snapshot", () => {
    const record = unitProvenance({ unit: RENDER_UNIT, footprints: footprints(), snapshot: { commitHash: null } });

    expect(record.commit).toBeNull();
  });
});
