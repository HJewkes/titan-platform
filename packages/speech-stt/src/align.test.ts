import { describe, expect, it } from "vitest";
import { align } from "./align.js";
import type { Word } from "./schemas.js";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });

describe("align", () => {
  // Mutation caught: unmatched words take the previous word's end, so all three collapse to 1.0.
  it("splits a 3-word unmatched run between matches at 1.0 and 1.6 s into three 0.2 s slots", () => {
    const script = ["Start", "alpha", "beta", "gamma", "finish"];
    const heard = [w("start", 0.5, 1.0), w("xx", 1.05, 1.2), w("yy", 1.25, 1.5), w("finish", 1.6, 2.0)];

    const timed = align(script, heard);

    expect(timed).toEqual([
      w("Start", 0.5, 1.0),
      w("alpha", 1.0, 1.2),
      w("beta", 1.2, 1.4),
      w("gamma", 1.4, 1.6),
      w("finish", 1.6, 2.0),
    ]);
  });

  // Mutation caught: punctuation or case left in the match key, so "Hello," never matches "hello".
  it("matches words ignoring case and punctuation and keeps the script spelling", () => {
    const timed = align(["Hello,", "World!"], [w("hello", 0, 0.4), w("world", 0.5, 0.9)]);

    expect(timed).toEqual([w("Hello,", 0, 0.4), w("World!", 0.5, 0.9)]);
  });

  // Mutation caught: the leading anchor dropped, so a run before the first match has no start edge.
  it("anchors a leading unmatched run at the first heard word's start", () => {
    const timed = align(["um", "uh", "go"], [w("so", 0.2, 0.3), w("go", 0.6, 0.8)]);

    expect(timed.map((x) => [x.start, x.end])).toEqual([
      [0.2, 0.4],
      [0.4, 0.6],
      [0.6, 0.8],
    ]);
  });

  // Mutation caught: autojunk left on, so a word filling half of a 240-word transcript stops anchoring.
  it("anchors on a word that repeats across a long transcript", () => {
    const script = Array.from({ length: 240 }, (_, i) => (i % 2 ? "the" : `s${i}`));
    const heard = Array.from({ length: 240 }, (_, i) => w(i % 2 ? "the" : `h${i}`, i, i + 0.5));

    const timed = align(script, heard);

    expect(timed[1]).toEqual(w("the", 1, 1.5));
  });

  // Mutation caught: half-up rounding, which gives 0.063 for 0.0625 where Python gives 0.062.
  it("rounds times to milliseconds half to even, as Python's round does", () => {
    const timed = align(["a"], [w("a", 0.0625, 0.1875)]);

    expect(timed).toEqual([w("a", 0.062, 0.188)]);
  });

  // Mutation caught: an empty transcript read as undefined anchors, which yields NaN times.
  it("refuses a transcript with no words", () => {
    expect(() => align(["a"], [])).toThrow(/at least one heard word/);
  });
});
