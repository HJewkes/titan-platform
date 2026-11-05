import { classify, ERROR_KINDS, type SampledFrame } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { gateFor, loadQaGate, parseGateProfile } from "./gate-profile.js";
import { OVERLAP } from "./qa-fakes.test-helpers.js";

const TYPES = new Set(["repo-tour", "daily-overview"]);

const profile = (types: string) => `schema: explainer.qa-gate-profile/v1\ndefault:\n  gate: [text-overlap, off-frame]\ntypes:\n${types}`;

/** The overlap at a beat's settled end moment: held under any profile that gates text-overlap. */
const SETTLED: SampledFrame[] = [{ beat: "b1", local: 3.8, t: 3.8, kind: "end", contentRuns: 3, findings: [OVERLAP] }];

describe("QA gate profile", () => {
  it("rejects a kind render-qa does not know", () => {
    const text = profile("  repo-tour:\n    gate: [text-overlapp]\n");

    expect(() => parseGateProfile(text, TYPES)).toThrow(/text-overlapp|Invalid option/);
  });

  it("rejects an override for a type no profile defines", () => {
    const text = profile("  explainer-short:\n    info: [off-frame]\n");

    expect(() => parseGateProfile(text, TYPES)).toThrow(/overrides explainer-short, which no types\/<type>.yaml defines/);
  });

  it("changes the verdict for the type whose override demotes a kind, and only for that type", () => {
    const file = parseGateProfile(profile("  daily-overview:\n    info: [text-overlap]\n"), TYPES);

    const daily = classify(SETTLED, { gate: gateFor(file, "daily-overview").gate });
    const tour = classify(SETTLED, { gate: gateFor(file, "repo-tour").gate });

    expect(daily.errors).toEqual([]);
    expect(tour.errors.map((held) => held.kind)).toEqual(["text-overlap"]);
  });

  it("ships a default that gates every kind render-qa can gate, as the spike's qa.ts did", () => {
    const shipped = loadQaGate(undefined);

    expect(new Set(shipped.gate)).toEqual(new Set(ERROR_KINDS));
    expect(shipped.inspect).toEqual({});
  });
});
