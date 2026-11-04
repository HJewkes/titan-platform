import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { formatRow, overflowRow, type TextLeaf } from "./overflow-row.js";

const leaf = (element: string, text: string, w: number, h = 52): TextLeaf => ({ element, text, w, h });
const NONE = { top: 0, right: 0, bottom: 0, left: 0 };

describe("an overflow row", () => {
  test("is undefined when the content fits", () => {
    const row = overflowRow("stats-1", NONE, [leaf("figures-1 beat-stat-label", "widgets", 160)]);

    assert.equal(row, undefined);
  });

  test("names the widest label of a row too wide and how many characters it may keep", () => {
    const leaves = [leaf("figures-1 beat-stat-label", "widgets", 160), leaf("figures-2 beat-stat-label", "twenty character lab", 400)];

    const row = overflowRow("stats-1", { ...NONE, right: 100 }, leaves);

    assert.deepEqual(row, {
      beat: "stats-1", element: "figures-2 beat-stat-label", px: 100, sides: { ...NONE, right: 100 },
      hint: 'shorten figures-2 beat-stat-label "twenty character lab" to <= 15 chars',
    });
  });

  test("counts both sides of a centred overflow toward the cut", () => {
    const row = overflowRow("stats-1", { ...NONE, left: 50, right: 50 }, [leaf("figures-1 beat-stat-label", "twenty character lab", 400)]);

    assert.equal(row?.hint, 'shorten figures-1 beat-stat-label "twenty character lab" to <= 15 chars');
  });

  test("names the tallest text of a column too tall and offers to drop an item", () => {
    const leaves = [leaf("items-1 beat-list-text", "short", 120, 60), leaf("items-2 beat-list-text", "a long item that wraps", 900, 200)];

    const row = overflowRow("list-1", { ...NONE, top: 25, bottom: 25 }, leaves);

    assert.ok(row);
    assert.equal(row.element, "items-2 beat-list-text");
    assert.equal(row.hint, 'shorten items-2 beat-list-text "a long item that wraps" to <= 16 chars or drop an item');
  });

  test("reads as the overflow, the element and the hint on one line", () => {
    const row = overflowRow("stats-1", { ...NONE, right: 100 }, [leaf("figures-2 beat-stat-label", "twenty character lab", 400)]);

    const line = row && formatRow(row);

    assert.equal(line, 'stats-1 overflows its stage box by 100 px (right 100): figures-2 beat-stat-label; shorten figures-2 beat-stat-label "twenty character lab" to <= 15 chars');
  });
});
