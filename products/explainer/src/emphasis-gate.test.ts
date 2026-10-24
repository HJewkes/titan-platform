import { describe, expect, it } from "vitest";
import { emphasisGateVerdict, emphasisTargetGate } from "./emphasis-gate.js";
import { emphasisLayout, emphasisScript, emphasisSlots, frame, gateInput } from "./emphasis-fixtures.test-helpers.js";

const problems = (input = gateInput()) => emphasisTargetGate(input).map((f) => `${f.beat}#${f.cue} ${f.target} ${f.problem}`);

describe("emphasis target gate", () => {
  it("passes when every emphasis cue resolves to one on-frame element", () => {
    expect(emphasisTargetGate(gateInput())).toEqual([]);
  });

  it("fails an ambiguous target: one id names a node and an edge", () => {
    const slots = emphasisSlots();
    slots["b2-map"]!.edges = [
      { id: "scan-to-desk", from: "scanner", to: "desk" },
      { id: "ledger", from: "desk", to: "ledger" },
    ];

    expect(emphasisTargetGate(gateInput({ slots }))).toEqual([
      { beat: "b2-map", cue: 1, target: "ledger", problem: "ambiguous", detail: "ledger names 2 elements of beat spec flow-map" },
    ]);
  });

  it("fails a target that names no element of the beat", () => {
    const slots = emphasisSlots();
    slots["b1-walk"]!.lines = [{ id: "open", text: "let total = 0;" }];

    expect(problems(gateInput({ slots }))).toEqual(["b1-walk#1 close no-element"]);
  });

  it("fails an element laid out off the frame", () => {
    const layout = emphasisLayout();
    layout.boxes["b2-map"]!.desk = { x: 1800, y: 480, width: 320, height: 120 };

    expect(emphasisTargetGate(gateInput({ layout }))).toEqual([
      { beat: "b2-map", cue: 0, target: "desk", problem: "off-frame", detail: "element desk is not wholly inside the frame" },
    ]);
  });

  it.each([
    ["above the frame", { x: 800, y: -10, width: 320, height: 120 }],
    ["left of the frame", { x: -1, y: 480, width: 320, height: 120 }],
    ["below the frame", { x: 800, y: 1000, width: 320, height: 120 }],
    ["with no area", { x: 800, y: 480, width: 0, height: 120 }],
    ["with no height", { x: 800, y: 480, width: 320, height: 0 }],
  ])("fails an element box %s", (_name, box) => {
    const layout = emphasisLayout();
    layout.boxes["b2-map"]!.desk = box;

    expect(problems(gateInput({ layout }))).toEqual(["b2-map#0 desk off-frame"]);
  });

  it("fails a target the layout never placed", () => {
    const layout = emphasisLayout();
    delete layout.boxes["b1-walk"];

    expect(problems(gateInput({ layout }))).toEqual(["b1-walk#0 open off-frame", "b1-walk#1 close off-frame"]);
  });

  it("checks only the mapping before layout", () => {
    expect(emphasisTargetGate(gateInput({ layout: undefined }))).toEqual([]);
  });

  it("fails every cue of a beat that names no beat spec", () => {
    const beats = emphasisScript().beats;
    delete beats[1]!.visual.beat;

    expect(problems(gateInput({ beats }))).toEqual(["b2-map#0 desk no-beat-spec", "b2-map#1 ledger no-beat-spec"]);
  });

  it.each([
    ["has no slots", () => gateInput({ slots: { "b1-walk": emphasisSlots()["b1-walk"] } }), /\(root\)/],
    ["names an unknown beat spec", () => gateInput({ beats: [{ ...emphasisScript().beats[1]!, visual: { ...emphasisScript().beats[1]!.visual, beat: "pie-chart" } }] }), /unknown beat pie-chart/],
  ])("fails the cues of a beat that %s", (_name, input, detail) => {
    const failures = emphasisTargetGate(input());

    expect(failures.map((f) => f.problem)).toEqual(["bad-slots", "bad-slots"]);
    expect(failures[0]!.detail).toMatch(detail);
  });

  describe("contact-sheet rule", () => {
    // A 32 × 18 stage keeps the mark frames small; `open` sits in the top left.
    const small = { stage: { width: 32, height: 18 }, boxes: { "b1-walk": { open: { x: 0, y: 0, width: 8, height: 4 }, close: { x: 0, y: 8, width: 8, height: 4 } } } };
    const beats = emphasisScript().beats.slice(0, 1);

    it("fails an emphasis step whose target does not change between its marks", () => {
      const marks = { "b1-walk": { 0: { before: frame(32, 18), after: frame(32, 18) } } };

      expect(problems(gateInput({ beats, layout: small, marks }))).toEqual(["b1-walk#0 open unchanged"]);
    });

    it("passes an emphasis step that changes its target", () => {
      const marks = { "b1-walk": { 0: { before: frame(32, 18), after: frame(32, 18, { x: 0, y: 0, width: 8, height: 4, level: 220 }) } } };

      expect(emphasisTargetGate(gateInput({ beats, layout: small, marks }))).toEqual([]);
    });

    it("fails a step that changes only another element", () => {
      const marks = { "b1-walk": { 1: { before: frame(32, 18), after: frame(32, 18, { x: 0, y: 0, width: 8, height: 4, level: 220 }) } } };

      expect(problems(gateInput({ beats, layout: small, marks }))).toEqual(["b1-walk#1 close unchanged"]);
    });
  });
});

describe("emphasis gate verdict", () => {
  it("passes with a count of the cues it checked", () => {
    expect(emphasisGateVerdict(gateInput())).toEqual({ pass: true, detail: "0 of 4 emphasis cues fail" });
  });

  it("fails naming the first failures by beat and cue", () => {
    const beats = emphasisScript().beats;
    delete beats[0]!.visual.beat;
    delete beats[1]!.visual.beat;
    beats.push({ ...beats[0]!, id: "b4-walk" }, { ...beats[1]!, id: "b5-map" });

    expect(emphasisGateVerdict(gateInput({ beats }))).toEqual({
      pass: false,
      detail: "8 of 8 emphasis cues fail: b1-walk#0 no-beat-spec, b1-walk#1 no-beat-spec, b2-map#0 no-beat-spec, b2-map#1 no-beat-spec, b4-walk#0 no-beat-spec and 3 more",
    });
  });
});
