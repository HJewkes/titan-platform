import { describe, expect, it } from "vitest";
// Recorded from CPython difflib; fixtures/README.md holds the generating command.
import golden from "./fixtures/sequence-matcher.golden.json" with { type: "json" };
import { SequenceMatcher } from "./sequence-matcher.js";

const bigCases = golden.cases.filter((c) => c.b.length >= 200);

describe("SequenceMatcher against CPython difflib", () => {
  // Mutation caught: any change to longest-match tie-breaking, the queue order or the
  // adjacent-block collapse shifts at least one pair's opcodes.
  it.each(golden.cases.map((c) => [c.name, c] as const))("%s: blocks, opcodes and ratio match", (_, c) => {
    const matcher = new SequenceMatcher(c.a, c.b, { autojunk: c.autojunk });

    const blocks = matcher.matchingBlocks().map((m) => [m.a, m.b, m.size]);

    expect(blocks).toEqual(c.matchingBlocks);
    expect(matcher.opcodes()).toEqual(c.opcodes);
    expect(matcher.ratio()).toBe(c.ratio);
  });

  // Mutation caught: autojunk ignored, so the 200-plus-item goldens with autojunk on differ.
  it("covers pairs over 200 items with autojunk both on and off", () => {
    expect(bigCases.filter((c) => c.autojunk).length).toBeGreaterThan(0);
    expect(bigCases.filter((c) => !c.autojunk).length).toBeGreaterThan(0);
    expect(golden.cases.length).toBeGreaterThanOrEqual(40);
  });

  // Mutation caught: autojunk applied by default off, unlike CPython where it defaults on.
  it("turns autojunk on when no option is given", () => {
    const c = bigCases.find((x) => x.autojunk)!;

    expect(new SequenceMatcher(c.a, c.b).opcodes()).toEqual(c.opcodes);
  });

  // Mutation caught: strings split by UTF-16 unit, so an astral character counts as two items.
  it("iterates strings by code point, as Python does", () => {
    const matcher = new SequenceMatcher("a😀b", "a😀c");

    expect(matcher.opcodes()).toEqual([
      ["equal", 0, 2, 0, 2],
      ["replace", 2, 3, 2, 3],
    ]);
  });
});
