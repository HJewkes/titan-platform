import { describe, expect, it } from "vitest";
import { beatsOf, FILLER, rowOf, withFiller } from "./hallmark-fixtures.test-helpers.js";

describe("hallmark:staccato-run", () => {
  it("counts two short sentences in a row as one run", () => {
    const row = rowOf(withFiller("It clicked. It held."), "hallmark:staccato-run");

    expect(row.value).toBeGreaterThan(0);
    expect(row.beats).toEqual([]);
  });

  it("counts no run for a lone short sentence", () => {
    expect(rowOf(withFiller("It clicked."), "hallmark:staccato-run").value).toBe(0);
  });
});

describe("hallmark:parallel-recap", () => {
  it("fires on three short sentences in one beat that open on the same word", () => {
    const recap = "The pump moves the water. The filter cleans it. The heater warms it.";

    expect(rowOf(withFiller(recap), "hallmark:parallel-recap")).toMatchObject({ value: 1, pass: false, beats: ["b11"] });
  });
});

describe("hallmark:frame-refrain", () => {
  const frame = (n: number) => `The bike shop ${["fixes", "sells", "rents"][n]} a wheel for anyone who walks in from the road.`;

  it("fires when one opening frame starts three sentences of a chapter", () => {
    const beats = [...beatsOf(FILLER), ...[0, 1, 2].map((n) => ({ id: `f${n}`, spoken: frame(n), chapter: "ch2" }))];

    expect(rowOf(beats, "hallmark:frame-refrain")).toMatchObject({ value: 3, pass: false });
  });

  it("does not fire when the three sentences sit in three chapters", () => {
    const beats = [...beatsOf(FILLER), ...[0, 1, 2].map((n) => ({ id: `f${n}`, spoken: frame(n), chapter: `ch${n + 2}` }))];

    expect(rowOf(beats, "hallmark:frame-refrain")).toMatchObject({ value: 1, pass: true });
  });
});

describe("hallmark:label-first", () => {
  it("fires on a short sentence that opens on a label", () => {
    expect(rowOf(withFiller("The fix is tempering."), "hallmark:label-first")).toMatchObject({ value: 1, pass: false });
  });

  it("does not fire on a label phrase inside a sentence", () => {
    expect(rowOf(withFiller("Riders think the key is speed."), "hallmark:label-first")).toMatchObject({ value: 0, pass: true });
  });
});
