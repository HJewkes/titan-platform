import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { inkShare, kindCells } from "./parity-sheet.js";
import { parseTimeline } from "./timeline.js";

const beat = (id: string, kind: string, startS: number, durationS: number, extra: object = {}) => ({ id, kind, startS, durationS, slots: {}, ...extra });

describe("the kind sheet's cells", () => {
  test("take each kind's first reveal plus 0.6 s and its end less 0.1 s", () => {
    const timeline = parseTimeline({ durationS: 5, beats: [beat("a", "held", 2, 3, { reveals: [{ target: "y", atS: 1.4 }, { target: "x", atS: 0.9 }] })] });

    const cells = kindCells(timeline).map((c) => [c.tag, Number(c.t.toFixed(3))]);

    assert.deepEqual(cells, [["first", 3.5], ["settled", 4.9]]);
  });

  // Mutation: settle every kind at its end less 0.1 s; an outro's settled frame lands in its fade and reads blank.
  test("settle an outro kind before its 1 s fade, not in it", () => {
    const timeline = parseTimeline({ durationS: 8, beats: [beat("a", "outro", 0, 4), beat("b", "button", 4, 4)] });

    const settled = kindCells(timeline).filter((c) => c.tag === "settled").map((c) => Number(c.t.toFixed(3)));

    assert.deepEqual(settled, [2.9, 6.9]);
  });

  test("start a beat with no reveals 0.6 s in", () => {
    const timeline = parseTimeline({ durationS: 2, beats: [beat("a", "hook", 0, 2)] });

    const [first] = kindCells(timeline);

    assert.equal(first?.t, 0.6);
  });

  test("never put the first frame after the settled one", () => {
    const timeline = parseTimeline({ durationS: 1, beats: [beat("a", "held", 0, 1, { reveals: [{ target: "x", atS: 0.8 }] })] });

    const times = kindCells(timeline).map((c) => c.t);

    assert.deepEqual(times, [0.9, 0.9]);
  });

  test("draw a kind once, from its first beat", () => {
    const timeline = parseTimeline({ durationS: 6, beats: [beat("a", "held", 0, 2), beat("b", "hook", 2, 2), beat("c", "held", 4, 2)] });

    const beats = [...new Set(kindCells(timeline).map((c) => `${c.kind}:${c.beat}`))];

    assert.deepEqual(beats, ["held:a", "hook:b"]);
  });

  // Mutation: key the sheet on the spec type alone; the line chart after a bar chart never reaches the sheet.
  test("draw a bar chart and a line chart each on their own row", () => {
    const chart = (kind: string) => ({ slots: { kind, series: [{ id: "series-1", label: "a", value: 1 }] } });
    const timeline = parseTimeline({ durationS: 6, beats: [beat("a", "chart", 0, 2, chart("bar")), beat("b", "chart", 2, 2, chart("line")), beat("c", "chart", 4, 2, chart("bar"))] });

    const beats = [...new Set(kindCells(timeline).map((c) => `${c.kind}:${c.beat}`))];

    assert.deepEqual(beats, ["chart-bar:a", "chart-line:b"]);
  });
});

describe("a frame's ink share", () => {
  test("is 0 for a frame of one grey", () => {
    assert.equal(inkShare(new Uint8Array(100).fill(17)), 0);
  });

  test("counts pixels off the commonest grey, past the antialiasing tolerance", () => {
    const frame = new Uint8Array(100).fill(17);
    frame.fill(240, 0, 10);
    frame.fill(22, 10, 30);

    assert.equal(inkShare(frame), 0.1);
  });
});
