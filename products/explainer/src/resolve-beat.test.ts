import { describe, expect, it } from "vitest";
import { loadBeatSpecs } from "./beat-load.js";
import { ResolveError, resolveBeat, resolveBeats, type ResolvedBeat } from "./resolve-beat.js";
import { oneBeat, resolveScript, visual } from "./resolve-fixtures.test-helpers.js";
import { FRAMING_ANCHORS, RESOLVE_ROWS } from "./resolve-tables.js";
import { shippedVisualRouter } from "./visual-router.js";

const specs = loadBeatSpecs();
const router = shippedVisualRouter();
const resolve = (fn: string, extra: Record<string, unknown> = {}) => resolveBeat(oneBeat(fn, extra), specs, router);
function resolved(fn: string, extra: Record<string, unknown> = {}): ResolvedBeat {
  const found = resolve(fn, extra);
  if ("code" in found) throw new Error(`expected a resolved beat, got ${found.code}: ${found.detail}`);
  return found;
}
const CODE = { file: "src/desk.ts", lines: [4, 8] };

describe("resolver tables", () => {
  it("resolves a numbers beat to the stat template on the focus framing's anchors", () => {
    expect(resolved("WHAT", { visual: visual({ labels: ["3 sent back"] }) })).toMatchObject({
      row: "numbers", beat: "stat", component: { name: "StatBeat", maturity: "spike" }, band: "concept", framing: "focus", layer: "template", anchors: ["B2:E5"],
      key: { function: "WHAT", job: "numbers", content: "items", route: "none" },
    });
  });

  it("picks by beat function: a numbers hook is a hook beat, a numbers stake a stakes beat", () => {
    expect(resolved("HOOK").beat).toBe("hook");
    expect(resolved("STAKE").beat).toBe("stakes");
    expect(resolved("WHAT").beat).toBe("stat");
  });

  it("routes a beat with a code excerpt to the code walk whatever its job", () => {
    expect(resolved("HOW", { visual: visual({ job: "code-proof", code: CODE }) })).toMatchObject({ row: "code-excerpt", beat: "code-walk", band: "code" });
    expect(resolved("HOOK", { visual: visual({ job: "numbers", code: CODE }) }).beat).toBe("code-walk");
  });

  it("routes by the visual-router type the beat's kind names", () => {
    expect(resolved("WHAT", { kind: "bar" })).toMatchObject({ row: "route-chart", beat: "chart", key: { route: "bar" } });
    expect(resolved("WHAT", { kind: "db-schema" }).beat).toBe("schema");
    expect(resolved("WHAT", { kind: "not-a-router-type" })).toMatchObject({ row: "numbers", key: { route: "none" } });
  });

  it("routes each visual job to its own row", () => {
    expect(resolved("WHAT", { visual: visual({ job: "map" }) }).beat).toBe("arch-map");
    expect(resolved("WHAT", { visual: visual({ job: "zoom" }) }).beat).toBe("zoom");
    expect(resolved("WHAT", { visual: visual({ job: "alternatives-vs-ours" }) })).toMatchObject({ beat: "compare", framing: "split", anchors: ["A1:C6", "D1:F6"] });
    expect(resolved("WHAT", { visual: visual({ job: "artifact-filling" }) }).beat).toBe("scorecard");
  });

  it("refuses a beat that matches no row with a coded error, and never falls back to a list", () => {
    expect(resolve("WHAT", { visual: visual({ job: "code-proof" }) })).toEqual({ beat: "b1", code: "E-RESOLVE-NO-ROW", detail: "no resolver row matches function WHAT, job code-proof, content statement, route none" });
  });

  it("refuses a beat whose job is still a TODO placeholder", () => {
    expect(resolve("WHAT", { visual: visual({ job: "TODO: pick a job" }) })).toMatchObject({ code: "E-RESOLVE-JOB-UNSET" });
  });

  it("resolves a cast-in-motion beat to a moving layer and refuses one authored as a still template", () => {
    expect(resolved("HOW", { visual: visual({ job: "cast-in-motion" }) })).toMatchObject({ row: "cast-in-motion", layer: "custom" });
    expect(resolve("HOW", { visual: visual({ job: "cast-in-motion", layer: "template" }) })).toMatchObject({ code: "E-RESOLVE-STILL-MOTION" });
  });

  it("lets the script's authored beat, framing, layer and anchors override the row's choice", () => {
    const beat = resolved("WHAT", { visual: visual({ beat: "list", framing: "split", layer: "custom" }) });
    expect(beat).toMatchObject({ row: "numbers", beat: "list", framing: "split", layer: "custom", anchors: [...FRAMING_ANCHORS.split] });
    expect(resolved("WHAT", { visual: visual({ anchors: ["A1:B2"] }) }).anchors).toEqual(["A1:B2"]);
  });

  it("refuses an authored beat spec the registry lacks", () => {
    expect(resolve("WHAT", { visual: visual({ beat: "no-such-beat" }) })).toMatchObject({ code: "E-RESOLVE-UNKNOWN-BEAT" });
  });

  it("throws one ResolveError naming every refused beat", () => {
    const script = resolveScript([["b1", "WHAT"], ["b2", "WHAT", { visual: visual({ job: "code-proof" }) }], ["b3", "WHAT", { visual: visual({ job: "TODO: later" }) }]]);

    const thrown = (() => {
      try {
        resolveBeats(script.beats, specs, router);
      } catch (error) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(ResolveError);
    expect(thrown instanceof ResolveError && thrown.refusals.map((r) => `${r.beat}:${r.code}`)).toEqual(["b2:E-RESOLVE-NO-ROW", "b3:E-RESOLVE-JOB-UNSET"]);
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
