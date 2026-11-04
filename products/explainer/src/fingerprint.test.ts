import { describe, expect, it } from "vitest";
import { fingerprintOf, layoutKey, sidecarFingerprint, stockGrams, type FingerprintInput } from "./fingerprint.js";
import type { ScriptV1 } from "./script-schema.js";
import { GOOD_BEATS, tour, withBeat } from "./voice-flow-fixtures.test-helpers.js";

type ResolvedBeat = NonNullable<FingerprintInput["resolved"]>["beats"][number];

function resolvedBeat(id: string, overrides: Partial<ResolvedBeat> = {}): ResolvedBeat {
  return {
    id, chapter: "ch1", key: { function: "HOOK", job: "numbers", content: "statement", route: "r1" }, row: "R1", beat: "verdict-card",
    component: { name: "VerdictCard", maturity: "shipped" }, band: "story", framing: "focus", layer: "template", anchors: [], ...overrides,
  };
}

const keyOf = (script: ScriptV1, id: string, extra: Partial<FingerprintInput> = {}): string =>
  fingerprintOf({ script, hooks: new Map(), ...extra }).beats.find((beat) => beat.id === id)!.layoutKey;

describe("the per-beat layout key", () => {
  it("joins component, slot count and anchors as component/slots/anchors", () => {
    const key = layoutKey({ component: "StatCard", slots: 3, anchors: ["B2", "C2"] });

    expect(key).toBe("StatCard/3/B2+C2");
  });

  it("takes the resolved component, the slots artifact's slot count and the expanded anchor range", () => {
    const resolved = { beats: [resolvedBeat("h1", { component: { name: "StatCard", maturity: "shipped" }, anchors: ["B2:C3"] })] };

    const key = keyOf(tour(), "h1", { resolved, slots: { h1: { value: "12", unit: "scans", label: "a day" } } });

    expect(key).toBe("StatCard/3/B2+C2+B3+C3");
  });

  it("names a resolved beat whose component has no name by its beat spec", () => {
    const resolved = { beats: [resolvedBeat("h1", { beat: "compare-pair", component: { maturity: "gap" } })] };

    const key = keyOf(tour(), "h1", { resolved });

    expect(key).toBe("spec:compare-pair/0/-");
  });

  it("reads the resolver's anchors before the script's, so a resolver default is never lost", () => {
    const script = tour(withBeat("h1", { extra: { visual: { assertion: "The desk refuses", job: "numbers", anchors: ["A1"] } } }));
    const resolved = { beats: [resolvedBeat("h1", { anchors: ["D4:E5"] })] };

    const key = keyOf(script, "h1", { resolved });

    expect(key).toBe("VerdictCard/0/D4+E4+D5+E5");
  });

  it("sorts the anchors row by row", () => {
    const resolved = { beats: [resolvedBeat("h1", { anchors: ["C3", "A1", "F1"] })] };

    const key = keyOf(tour(), "h1", { resolved });

    expect(key).toBe("VerdictCard/0/A1+F1+C3");
  });

  it("falls back to the script's render hint and label count with no resolved artifact", () => {
    const script = tour(withBeat("h1", { extra: { visual: { assertion: "The desk refuses", job: "numbers", render: "TerminalBeat", labels: ["scan", "print"], anchors: ["A1"] } } }));

    const key = keyOf(script, "h1");

    expect(key).toBe("TerminalBeat/2/A1");
  });

  it("falls back to the visual job when the script names no render", () => {
    const key = keyOf(tour(), "h2");

    expect(key).toBe("job:numbers/0/-");
  });
});

describe("fingerprintOf", () => {
  it("records the hook of the script's structure, the histogram of components and a null pixel per beat", () => {
    const script: ScriptV1 = { ...tour(), structure: "problem-first" };

    const print = fingerprintOf({ script, hooks: new Map([["problem-first", "cost-of-failure"]]) });

    expect(print.hookKind).toBe("cost-of-failure");
    expect(print.componentHistogram).toEqual({ "job:numbers": GOOD_BEATS.length });
    expect(print.beats.every((beat) => beat.pixel === null)).toBe(true);
    expect(print).toMatchObject({ opening: "h1", closeKind: "callback", profile: "repo-tour" });
  });

  it("gives a script with no structure no hook kind", () => {
    const print = fingerprintOf({ script: tour(), hooks: new Map([["problem-first", "cost-of-failure"]]) });

    expect(print.hookKind).toBeNull();
  });

  it("carries the stock grams in the sidecar by hash only", () => {
    const print = fingerprintOf({ script: tour(), hooks: new Map() });

    const carried = sidecarFingerprint(print);

    expect(carried).not.toHaveProperty("stockGrams");
    expect(carried.stockGramsSha).toMatch(/^[0-9a-f]{64}$/);
    expect(print.stockGrams.length).toBeGreaterThan(0);
  });
});

describe("stockGrams", () => {
  it("masks numbers and known terms, so only the stock wording around them counts", () => {
    const a = stockGrams(["The desk scanned 12 parcels for Lantern before noon."], ["Lantern"]);
    const b = stockGrams(["The desk scanned 40 parcels for Harbor before noon."], ["Harbor"]);

    expect(a).toEqual(b);
  });

  it("tells two different wordings apart", () => {
    const a = stockGrams(["The desk scanned every parcel before noon."]);
    const b = stockGrams(["A courier printed one label after dusk today."]);

    expect(a.filter((gram) => b.includes(gram))).toEqual([]);
  });
});
