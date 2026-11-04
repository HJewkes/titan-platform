import { describe, expect, it } from "vitest";
import { resolveOne as resolve, resolvedOne as resolved, shippedRouter as router, shippedSpecs as specs, visual } from "./resolve-fixtures.test-helpers.js";
import { RESOLVE_ROWS } from "./resolve-tables.js";

describe("resolver tables", () => {
  it("picks by beat function: a numbers hook is a hook beat, a numbers stake a stakes beat", () => {
    expect(resolved("HOOK").beat).toBe("hook");
    expect(resolved("STAKE").beat).toBe("stakes");
    expect(resolved("WHAT").beat).toBe("stat");
  });

  it("routes by the visual-router type the beat's kind names", () => {
    expect(resolved("WHAT", { kind: "bar" })).toMatchObject({ row: "route-chart", beat: "chart", key: { route: "bar" } });
    expect(resolved("WHAT", { kind: "db-schema" }).beat).toBe("schema");
    expect(resolved("WHAT", { kind: "not-a-router-type" })).toMatchObject({ row: "numbers", key: { route: "none" } });
  });

  it("voices a HOW beat's code proof with no excerpt as a proof beat at the code band", () => {
    expect(resolved("HOW", { visual: visual({ job: "code-proof" }) })).toMatchObject({ row: "code-proof", beat: "proof", band: "code", framing: "focus" });
    expect(resolved("HOW", { visual: visual({ job: "code-proof", labels: ["base fails", "head passes"] }) })).toMatchObject({ row: "code-proof", key: { content: "items" } });
  });

  it("refuses a beat that matches no row with a coded error, and never falls back to a list", () => {
    expect(resolve("WHAT", { visual: visual({ job: "code-proof" }) })).toEqual({ beat: "b1", code: "E-RESOLVE-NO-ROW", detail: "no resolver row matches function WHAT, job code-proof, content statement, route none" });
  });

  describe("table invariants", () => {
    it("has no catch-all row: every row lists at least one field", () => {
      expect(RESOLVE_ROWS.filter((row) => Object.keys(row.when).length === 0).map((row) => row.id)).toEqual([]);
    });

    it("names only beat specs the shipped registry holds", () => {
      expect(RESOLVE_ROWS.filter((row) => !specs.has(row.then.beat)).map((row) => row.id)).toEqual([]);
    });

    it("routes only on visual-router types the pinned router knows", () => {
      const known = new Set(router.types.map((type) => type.id));
      expect(RESOLVE_ROWS.flatMap((row) => row.when.route ?? []).filter((route) => !known.has(route))).toEqual([]);
    });

    it("never sends a cast-in-motion row to a still template", () => {
      expect(RESOLVE_ROWS.filter((row) => row.when.job?.includes("cast-in-motion") && row.then.layer !== "custom")).toEqual([]);
    });
  });
});
