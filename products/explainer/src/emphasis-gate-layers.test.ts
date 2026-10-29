import { describe, expect, it } from "vitest";
import { emphasisGateVerdict, emphasisTargetGate } from "./emphasis-gate.js";
import { emphasisScript, emphasisSlots, gateInput } from "./emphasis-fixtures.test-helpers.js";

// Synthetic: the invented code walk and map of the emphasis fixtures, b2-map drawn as a built custom layer.
const problems = (input = gateInput()) => emphasisTargetGate(input).map((f) => `${f.beat}#${f.cue} ${f.target} ${f.problem}`);

describe("emphasis target gate on custom layers", () => {
  it("holds a custom beat's cues to the ids its built layer exposes, not to slots its beat spec would need", () => {
    // Arrange
    const slots = emphasisSlots();
    delete slots["b2-map"];

    // Act
    const found = problems(gateInput({ slots, layers: { "b2-map": ["desk", "ledger"] } }));

    // Assert
    expect(found).toEqual([]);
  });

  it("fails a custom beat's cue whose target its built layer does not expose, naming what it does expose", () => {
    // Arrange / Act
    const found = emphasisTargetGate(gateInput({ layers: { "b2-map": ["desk"] } }));

    // Assert
    expect(found).toEqual([
      { beat: "b2-map", cue: 1, target: "ledger", problem: "no-element", detail: "ledger is not an element the custom layer exposes (it exposes desk)" },
    ]);
  });
});

describe("emphasis gate verdict on many failures", () => {
  it("lists all seven failing cues past the fifth, each with its target and reason, and one hint per kind of failure", () => {
    // Arrange
    const beats = emphasisScript().beats;
    beats.push({ ...beats[1]!, id: "b3-map" }, { ...beats[1]!, id: "b4-map" }, { ...beats[1]!, id: "b5-map" });
    const slots = emphasisSlots();
    delete slots["b2-map"];
    const layers = { "b3-map": [], "b4-map": [], "b5-map": ["desk"] };

    // Act
    const verdict = emphasisGateVerdict({ ...gateInput({ beats, slots, layers }), layout: undefined });

    // Assert
    expect(verdict.pass).toBe(false);
    expect(verdict.detail.split("; ").length).toBeGreaterThanOrEqual(7);
    expect(verdict.detail).toMatch(/^7 of 10 emphasis cues fail: b2-map#0 desk bad-slots \(/);
    expect(verdict.detail).toContain("b5-map#1 ledger no-element (ledger is not an element the custom layer exposes (it exposes desk))");
    expect(verdict.detail).toMatch(/\. Hint: give the beat slots its beat spec parses; point each cue at an element its beat draws/);
  });
});
