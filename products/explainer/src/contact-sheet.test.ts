import { describe, expect, it } from "vitest";
import { chapterSheets, cutCells, SETTLE_S, type SheetCell, type SheetInput } from "./contact-sheet.js";

/** A synthetic parcel-desk video: one beat of each kind the rules tell apart. */
const BEATS = [
  { id: "b01-title", chapter: "ch1", render: "TitleBeat", durationS: 5, cues: [] },
  { id: "b02-rows", chapter: "ch1", render: "ListBeat", durationS: 6, cues: [1.2, 2.6, 4] },
  { id: "b03-ask", chapter: "ch2", render: "ListBeat", heading: "Who scans first?", durationS: 5.5, cues: [1.8, 3.2] },
  { id: "b10-walk", chapter: "ch2", render: "CodeWalkBeat", durationS: 7.5, cues: [2, 3.6, 5.2] },
  { id: "b11-bars", chapter: "ch3", render: "BarChartBeat", durationS: 5, cues: [1, 2.5] },
  { id: "b12-outro", chapter: "ch3", render: "OutroBeat", durationS: 6, cues: [] },
];

function video(): SheetInput {
  let startS = 0;
  const timeline = BEATS.map(({ id, durationS }) => {
    const beat = { id, startS, durationS };
    startS += durationS;
    return beat;
  });
  return {
    render: { beats: timeline },
    cues: { cues: BEATS.flatMap(({ id, cues }) => cues.map((atS) => ({ beat: id, atS }))) },
    visual: { beats: BEATS.map(({ id, chapter, render, ...rest }) => ({ id, chapter, render, ...("heading" in rest ? { heading: rest.heading } : {}) })) },
  };
}

/** Lengthens one beat by `seconds` and shifts every later beat: `hold` freezes its last frame, `slow` reads it slower. */
function lengthen(input: SheetInput, beatId: string, seconds: number, mode: "hold" | "slow"): SheetInput {
  const target = input.render.beats.find((beat) => beat.id === beatId)!;
  const factor = (target.durationS + seconds) / target.durationS;
  const beats = input.render.beats.map((beat) => {
    if (beat.id === beatId) return { ...beat, durationS: beat.durationS + seconds };
    return beat.startS > target.startS ? { ...beat, startS: beat.startS + seconds } : beat;
  });
  const cues = input.cues.cues.map((cue) => (mode === "slow" && cue.beat === beatId ? { ...cue, atS: cue.atS * factor } : cue));
  return { ...input, render: { beats }, cues: { cues } };
}

// Cell times are rounded to the millisecond.
const EPSILON = 1e-3;

/** What a frame shows at a cell: how many of its beat's cues have landed, and whether anything is still easing in. */
function picture(input: SheetInput, cell: SheetCell): string {
  const cues = input.cues.cues.filter((cue) => cue.beat === cell.beat).map((cue) => cue.atS);
  const landed = cues.filter((at) => at <= cell.local).length;
  const easing = cell.local < SETTLE_S || cues.some((at) => at <= cell.local && cell.local < at + SETTLE_S - EPSILON);
  return `${cell.beat}:${landed}${easing ? ":easing" : ""}`;
}

const pictures = (input: SheetInput) => Object.fromEntries(cutCells(input).map((cell) => [cell.key, picture(input, cell)]));
const tagsOf = (input: SheetInput, beat: string) => cutCells(input).filter((cell) => cell.beat === beat).map((cell) => cell.tag);

describe("cutCells", () => {
  it("cuts a 3-row list once, at its settled last frame", () => {
    const cells = cutCells(video()).filter((cell) => cell.beat === "b02-rows");

    expect(cells).toEqual([expect.objectContaining({ key: "b02-rows/settled", rule: "build", local: 5.8, t: 10.8 })]);
  });

  it("cuts a code walk with 3 cues into the whole view and one cell per focus step", () => {
    const cells = cutCells(video()).filter((cell) => cell.beat === "b10-walk");

    expect(cells.map((cell) => [cell.tag, cell.local])).toEqual([["before", 1.9], ["step1", 2.9], ["step2", 4.5], ["step3", 6.1]]);
  });

  it("shows a swapped-out question before its first row, then the settled rows", () => {
    expect(tagsOf(video(), "b03-ask")).toEqual(["before", "settled"]);
  });

  it("skips the before cell of a swap whose question never settles before the first row", () => {
    const input = video();
    input.cues.cues = input.cues.cues.map((cue) => (cue.beat === "b03-ask" && cue.atS === 1.8 ? { ...cue, atS: 0.6 } : cue));

    expect(tagsOf(input, "b03-ask")).toEqual(["settled"]);
  });

  it("cuts a chart per highlight, a title at its held end and an outro before its exit", () => {
    const cells = cutCells(video());

    expect(cells.filter((cell) => cell.beat === "b11-bars").map((cell) => cell.local)).toEqual([1.9, 3.4]);
    expect(cells.find((cell) => cell.beat === "b01-title")).toMatchObject({ rule: "hero", local: 4.8 });
    expect(cells.find((cell) => cell.beat === "b12-outro")).toMatchObject({ rule: "hero-before-exit", local: 4.8 });
  });

  it("puts no cell inside the beat's entrance or a cue's entrance", () => {
    const input = video();

    expect(Object.values(pictures(input)).filter((shown) => shown.endsWith(":easing"))).toEqual([]);
  });

  it.each(["hold", "slow"] as const)("changes no cell when an early beat is lengthened by 2 s (%s)", (mode) => {
    const before = pictures(video());

    const after = pictures(lengthen(video(), "b02-rows", 2, mode));

    expect(after).toEqual(before);
  });

  it.each(["hold", "slow"] as const)("changes no cell when the code walk itself is lengthened by 2 s (%s)", (mode) => {
    const before = pictures(video());

    const after = pictures(lengthen(video(), "b10-walk", 2, mode));

    expect(after).toEqual(before);
  });

  it("cuts a beat by its page marks when the page publishes them, and the rest by rule", () => {
    const input = { ...video(), marks: [{ t: 28.6, beat: "b11-bars", kind: "settled" as const }, { t: 26, beat: "b11-bars", kind: "step" as const }] };

    const cells = cutCells(input);

    expect(cells.filter((cell) => cell.beat === "b11-bars").map((cell) => [cell.rule, cell.tag, cell.local])).toEqual([["marks", "step1", 2], ["marks", "settled1", 4.6]]);
    expect(tagsOf(input, "b10-walk")).toEqual(["before", "step1", "step2", "step3"]);
  });

  it("labels each cell with its beat, rule, tag and video time", () => {
    expect(cutCells(video()).find((cell) => cell.key === "b10-walk/step2")?.label).toBe("b10-walk focus step2 21.0s");
  });
});

describe("chapterSheets", () => {
  it("groups cells into one sheet per chapter, in video order", () => {
    const sheets = chapterSheets(cutCells(video()));

    expect(sheets.map(({ chapter, cells }) => [chapter, cells.length])).toEqual([["ch1", 2], ["ch2", 6], ["ch3", 3]]);
  });
});
