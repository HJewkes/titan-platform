import { describe, expect, it } from "vitest";
import { ResolveError, resolveBeats } from "./resolve-beat.js";
import { resolveOne as resolve, resolvedOne as resolved, resolveScript, shippedRouter as router, shippedSpecs as specs, visual } from "./resolve-fixtures.test-helpers.js";
import { FRAMING_ANCHORS } from "./resolve-tables.js";

const CODE = { file: "src/desk.ts", lines: [4, 8] };

describe("resolver tables", () => {
  it("resolves a numbers beat to the stat template on the focus framing's anchors", () => {
    expect(resolved("WHAT", { visual: visual({ labels: ["3 sent back"] }) })).toMatchObject({
      row: "numbers", beat: "stat", component: { name: "StatBeat", maturity: "spike" }, band: "concept", framing: "focus", layer: "template", anchors: ["B2:E5"],
      key: { function: "WHAT", job: "numbers", content: "items", route: "none" },
    });
  });

  it("routes a beat with a code excerpt to the code walk whatever its job", () => {
    expect(resolved("HOW", { visual: visual({ job: "code-proof", code: CODE }) })).toMatchObject({ row: "code-excerpt", beat: "code-walk", band: "code" });
    expect(resolved("HOOK", { visual: visual({ job: "numbers", code: CODE }) }).beat).toBe("code-walk");
  });

  it("routes each visual job to its own row", () => {
    expect(resolved("WHAT", { visual: visual({ job: "map" }) }).beat).toBe("arch-map");
    expect(resolved("WHAT", { visual: visual({ job: "zoom" }) }).beat).toBe("zoom");
    expect(resolved("WHAT", { visual: visual({ job: "alternatives-vs-ours" }) })).toMatchObject({ beat: "compare", framing: "split", anchors: ["A1:C6", "D1:F6"] });
    expect(resolved("WHAT", { visual: visual({ job: "artifact-filling" }) }).beat).toBe("scorecard");
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
});
