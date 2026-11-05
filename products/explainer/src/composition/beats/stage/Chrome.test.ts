import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { chipText, SOURCE_BUDGET, sourceLine } from "./Chrome.js";
import { revealFrom } from "./reveal.js";

describe("the chrome's source line", () => {
  test("shortens the first source to its file and counts the rest", () => {
    const chips = [
      { kind: "verified", text: "demo@0a1b2c3:src/router/match.ts:12-40; docs/routing.md" },
      { kind: "our-framing", text: "hand layout of the router map" },
    ];

    const line = sourceLine(chips);

    assert.deepEqual(line, { kind: "verified", text: "match.ts:12-40", more: 2 });
  });

  test("is absent when the beat cites no source", () => {
    assert.equal(sourceLine([]), undefined);
  });

  test("rejects a source over the budget instead of clipping it", () => {
    const chips = [{ kind: "computed", text: "x".repeat(SOURCE_BUDGET + 1) }];

    assert.throws(() => sourceLine(chips), /over the 63-character chip budget/);
  });

  test("renders a source that fills the budget with no other sources", () => {
    const chips = [{ kind: "computed", text: "x".repeat(SOURCE_BUDGET) }];

    assert.equal(sourceLine(chips)?.more, 0);
  });

  test("counts the +N against the budget", () => {
    const chips = [{ kind: "computed", text: `${"x".repeat(SOURCE_BUDGET - 2)}; a.ts:1; b.ts:2` }];

    assert.throws(() => sourceLine(chips), /over the \d+-character chip budget/);
  });

  test("shows +N after the shortened source", () => {
    assert.equal(chipText({ kind: "verified", text: "match.ts:12", more: 2 }), "match.ts:12 +2");
  });
});

describe("a stage beat's reveals", () => {
  const reveal = revealFrom([
    { target: "row-1", atS: 0.8 },
    { target: "row-2", part: "left", atS: 1.2 },
    { target: "row-2", part: "right", atS: 1.9 },
  ]);

  test("give a target its cue word's time", () => {
    assert.equal(reveal("row-1"), 0.8);
  });

  test("give each compare side its own time", () => {
    assert.deepEqual([reveal("row-2", "left"), reveal("row-2", "right")], [1.2, 1.9]);
  });

  test("leave an uncued target, or an uncued side, undefined", () => {
    assert.deepEqual([reveal("row-3"), reveal("row-1", "left"), reveal("row-2")], [undefined, undefined, undefined]);
  });
});
