import { describe, expect, it } from "vitest";
import { IllegalPhaseEdgeError, PHASE_EDGES, illegalEdgeError, illegalEdges } from "./claim-phase.js";
import { PHASES, type Claim, type Phase } from "./schema.js";

const AT = "2026-01-05T06:00:00.000Z";

const claim = (phase: Phase, patch: Partial<Claim> = {}): Claim => ({
  taskId: "TX-1",
  initiative: "demo",
  spawnedAt: AT,
  phase,
  phaseAt: AT,
  ...patch,
});

const EDGES = PHASES.flatMap((from) => PHASE_EDGES[from].map((to) => [from, to] as const));
const ILLEGAL = PHASES.flatMap((from) =>
  PHASES.filter((to) => to !== from && !PHASE_EDGES[from].includes(to)).map((to) => [from, to] as const),
);

describe("illegalEdges", () => {
  it.each(EDGES)("allows %s to %s", (from, to) => {
    expect(illegalEdges([claim(from)], [claim(to)])).toEqual([]);
  });

  it("refuses queued to shepherding and names the claim", () => {
    const before = [claim("queued", { slice: "a" })];
    const after = [claim("shepherding", { slice: "a" })];

    expect(illegalEdges(before, after)).toEqual([{ claim: "TX-1#a", from: "queued", to: "shepherding" }]);
    const error = illegalEdgeError(before, after);
    expect(error).toBeInstanceOf(IllegalPhaseEdgeError);
    expect(error?.message).toBe("claim TX-1#a may not move from queued to shepherding");
  });

  it.each(ILLEGAL)("refuses %s to %s", (from, to) => {
    expect(illegalEdges([claim(from)], [claim(to)])).toEqual([{ claim: "TX-1#", from, to }]);
  });

  it("passes a write that keeps the phase", () => {
    const before = [claim("shepherding")];
    const after = [claim("shepherding", { lastReport: "refreshed" })];

    expect(illegalEdges(before, after)).toEqual([]);
    expect(illegalEdgeError(before, after)).toBeUndefined();
  });

  it("does not hold a claim added in any phase to an edge", () => {
    expect(illegalEdges([claim("done")], [claim("done"), claim("shepherding", { taskId: "TX-2" })])).toEqual([]);
  });

  it("pairs claims of one key by position", () => {
    const before = [claim("done"), claim("queued")];

    expect(illegalEdges(before, [claim("done"), claim("spawning")])).toEqual([]);
    expect(illegalEdges(before, [claim("done"), claim("shepherding")])).toEqual([
      { claim: "TX-1#", from: "queued", to: "shepherding" },
    ]);
  });
});
