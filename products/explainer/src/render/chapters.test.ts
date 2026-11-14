import { describe, expect, it } from "vitest";
import { layoutChapters, type ChapterBeat } from "./chapters.js";

const CHAPTERS = [
  { id: "setup", label: "Setup" },
  { id: "middle", label: "The middle" },
  { id: "close", label: "Close" },
];

/** Beats back to back from `fromS`, each with its chapter and length. */
function played(rows: readonly [string | undefined, number][], fromS = 0): ChapterBeat[] {
  let at = fromS;
  return rows.map(([chapter, durationS]) => {
    const beat = { ...(chapter === undefined ? {} : { chapter }), startS: at, durationS };
    at += durationS;
    return beat;
  });
}

describe("layoutChapters", () => {
  it("ends each chapter where the next one opens, and the last at the video's end", () => {
    const beats = played([["setup", 2.5], ["setup", 3], ["middle", 4.25], ["close", 1.5]]);

    const chapters = layoutChapters(CHAPTERS, beats);

    expect(chapters).toEqual([
      { id: "setup", n: 1, title: "Setup", startS: 0, endS: 5.5 },
      { id: "middle", n: 2, title: "The middle", startS: 5.5, endS: 9.75 },
      { id: "close", n: 3, title: "Close", startS: 9.75, endS: 11.25 },
    ]);
  });

  it("opens the first chapter at 0 when a page extra with no chapter plays first", () => {
    const beats = played([[undefined, 1.2], ["setup", 2], ["middle", 2]]);

    const [first, second] = layoutChapters(CHAPTERS, beats);

    expect(first).toMatchObject({ id: "setup", startS: 0, endS: 3.2 });
    expect(second).toMatchObject({ startS: 3.2, endS: 5.2 });
  });

  it("keeps an extra with no chapter inside the chapter it follows", () => {
    const beats = played([["setup", 2], [undefined, 1], ["middle", 2]]);

    const chapters = layoutChapters(CHAPTERS, beats);

    expect(chapters.map((c) => [c.startS, c.endS])).toEqual([[0, 3], [3, 5]]);
  });

  it("leaves out a chapter with no beats and keeps the script's numbering", () => {
    const beats = played([["setup", 2], ["close", 2]]);

    const chapters = layoutChapters(CHAPTERS, beats);

    expect(chapters.map((c) => [c.id, c.n])).toEqual([["setup", 1], ["close", 3]]);
    expect(chapters[0]!.endS).toBe(chapters[1]!.startS);
  });

  it("rounds to the millisecond so a boundary is one number on both sides", () => {
    const beats = played([["setup", 1 / 3], ["middle", 1 / 3], ["close", 1 / 3]]);

    const chapters = layoutChapters(CHAPTERS, beats);

    expect(chapters.map((c) => [c.startS, c.endS])).toEqual([[0, 0.333], [0.333, 0.667], [0.667, 1]]);
  });

  it("refuses a chapter whose beats play on either side of another chapter", () => {
    const beats = played([["setup", 1], ["middle", 1], ["setup", 1]]);

    expect(() => layoutChapters(CHAPTERS, beats)).toThrow(/chapter "setup" opens again at 2 s/);
  });

  it("refuses a beat naming a chapter the script does not list", () => {
    expect(() => layoutChapters(CHAPTERS, played([["epilogue", 1]]))).toThrow(/chapter "epilogue", which the script does not list/);
  });
});
