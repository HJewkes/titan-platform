import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BeatSlotError, UnknownBeatError } from "../beat-load.js";
import { parseTimeline } from "../composition/timeline.js";
import { StoryboardSchema } from "../storyboard.js";
import { sha256 } from "../workflow/artifacts.js";
import type { PageExtras } from "./board-from-fill.js";
import { compileTimeline, writeTimeline } from "./compile-timeline.js";

const rawBoard = (cues: Record<string, string[]> = {}) => ({
  video_type: "sample-type",
  title: "A synthetic board",
  beats: [
    { id: "beat-01", type: "hook", duration_s: 4, spoken: "Builds fail on a cold cache.", slots: { line: "Builds fail cold" }, cues: cues["beat-01"] },
    {
      id: "beat-02",
      type: "list",
      duration_s: 5,
      spoken: "First row, then the second row.",
      slots: { title: "Two rows", rows: [{ id: "one", text: "First", mark: "tick" }, { id: "two", text: "Second", mark: "risk" }] },
      cues: cues["beat-02"],
    },
    { id: "beat-03", type: "outro", duration_s: 3, spoken: "That is the fix.", slots: { line: "That is the fix" }, cues: cues["beat-03"] },
  ],
});

const board = (cues?: Record<string, string[]>) => StoryboardSchema.parse(rawBoard(cues));

const word = (text: string, start: number) => ({ word: text, start });
const words = () => ({
  beats: [
    { id: "beat-01", durationS: 4.5, words: [word("Builds", 0.1), word("fail", 0.4), word("cold", 1.2)] },
    { id: "beat-02", durationS: 6.2, words: [word("First", 0.2), word("row,", 0.6), word("then", 1.1), word("the", 1.4), word("second", 1.6), word("row.", 2.3)] },
    { id: "beat-03", durationS: 3.1, words: [word("That", 0.1), word("fix.", 0.9)] },
  ],
});

const listExtras = (reveals: PageExtras["reveals"]): Map<string, PageExtras> => new Map([["beat-02", {
  reveals,
  chips: [{ kind: "source", text: "A synthetic source" }],
  hints: { headingYields: true },
  headline: "Two rows land in order",
  chapter: { n: 2, of: 3, label: "The rows" },
}]]);

const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)]));
};

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "compile-timeline-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("compileTimeline", () => {
  it("durations come from words and sum to the timeline length", () => {
    const input = board();

    const timeline = compileTimeline(input, words());

    expect(timeline.beats.map((beat) => beat.durationS)).toEqual([4.5, 6.2, 3.1]);
    expect(timeline.beats.map((beat) => beat.startS)).toEqual([0, 4.5, 4.5 + 6.2]);
    expect(timeline.durationS).toBeCloseTo(13.8, 9);
  });

  it("errors on a cue word that is not spoken", () => {
    const input = board({ "beat-02": ["zebra"] });

    const compile = () => compileTimeline(input, words());

    expect(compile).toThrow('cue "zebra" is not spoken in beat-02');
  });

  it("resolves word#n to the beat-local start of the nth occurrence, ordered by time", () => {
    const input = board({ "beat-02": ["row#2", "first", "row"] });

    const timeline = compileTimeline(input, words());

    const cues = timeline.beats[1]?.cues ?? {};
    expect(cues).toEqual({ first: 0.2, row: 0.6, "row#2": 2.3 });
    expect(Object.keys(cues)).toEqual(["first", "row", "row#2"]);
  });

  it("gives a provisional timeline on planned durations with no cues when there are no words", () => {
    const input = board({ "beat-02": ["row"] });

    const silent = compileTimeline(input);
    const voiced = compileTimeline(input, words());

    expect(silent.provisional).toBe(true);
    expect(silent.durationS).toBe(12);
    expect(silent.beats.map((beat) => [beat.startS, beat.durationS])).toEqual([[0, 4], [4, 5], [9, 3]]);
    expect(silent.beats.every((beat) => beat.cues === undefined)).toBe(true);
    expect(voiced.provisional).toBe(false);
  });

  it("writes identical bytes when every input object's keys are shuffled", () => {
    const cues = { "beat-01": ["fail"], "beat-02": ["row#2", "then"] };
    const straight = writeTimeline(scratch(), compileTimeline(board(cues), words()));
    const shuffledBoard = StoryboardSchema.parse(reverseKeys(rawBoard(cues)));

    const shuffled = writeTimeline(scratch(), compileTimeline(shuffledBoard, reverseKeys(words())));

    expect(readFileSync(shuffled, "utf8")).toBe(readFileSync(straight, "utf8"));
  });

  it("parses slots through the beat registry schemas, applying their defaults", () => {
    const bad = StoryboardSchema.parse({ ...rawBoard(), beats: [{ ...rawBoard().beats[0], slots: { line: "" } }] });
    const unknown = StoryboardSchema.parse({ ...rawBoard(), beats: [{ ...rawBoard().beats[0], type: "no-such-beat" }] });

    const timeline = compileTimeline(board());

    expect(() => compileTimeline(bad)).toThrow(BeatSlotError);
    expect(() => compileTimeline(unknown)).toThrow(UnknownBeatError);
    expect(timeline.beats[0]).toMatchObject({ kind: "hook", slots: { line: "Builds fail cold", cards: [] } });
  });

  it("refuses a words.json beat the board lacks", () => {
    const extra = words();
    extra.beats.push({ id: "beat-04", durationS: 2, words: [] });

    expect(() => compileTimeline(board(), extra)).toThrow("words.json names beat-04, which the board lacks");
  });

  it("refuses a board beat that was never voiced", () => {
    const short = words();
    short.beats.pop();

    expect(() => compileTimeline(board(), short)).toThrow("beat-03 was never voiced");
  });

  it("refuses a words.json that drifts from its schema", () => {
    const drifted = { beats: [{ id: "beat-01", duration: 4 }] };

    expect(() => compileTimeline(board(), drifted)).toThrow();
  });

  it("writes timeline.json that the page schema reads back unchanged", () => {
    const timeline = compileTimeline(board({ "beat-01": ["cold"] }), words());

    const path = writeTimeline(scratch(), timeline);

    expect(path.endsWith("timeline.json")).toBe(true);
    expect(parseTimeline(JSON.parse(readFileSync(path, "utf8")))).toEqual(timeline);
  });
});

describe("compileTimeline page extras", () => {
  it("lands each reveal on its cue word's spoken start and carries the chrome inputs", () => {
    const extras = listExtras([{ target: "rows-1", atCue: "first" }, { target: "rows-2", part: "right", atCue: "row#2" }]);

    const timeline = compileTimeline(board(), words(), { extras });

    expect(timeline.beats[1]).toMatchObject({
      reveals: [{ target: "rows-1", atS: 0.2 }, { target: "rows-2", part: "right", atS: 2.3 }],
      chips: [{ kind: "source", text: "A synthetic source" }],
      hints: { headingYields: true },
      headline: "Two rows land in order",
      chapter: { n: 2, of: 3, label: "The rows" },
    });
    expect(timeline.beats[0]).not.toHaveProperty("reveals");
  });

  it("lands reveals at planned-word times scaled to the planned seconds when there are no words", () => {
    const extras = listExtras([{ target: "rows-1", atCue: "then" }, { target: "rows-2", atCue: "row#2" }]);

    const timeline = compileTimeline(board(), undefined, { extras });

    const [first, second] = timeline.beats[1]?.reveals ?? [];
    expect(first?.atS).toBeCloseTo((2 / 6) * 5, 9);
    expect(second?.atS).toBeCloseTo((5 / 6) * 5, 9);
  });

  it("scales planned reveals over the words a listener hears, not the markup around them", () => {
    // Catches: the planned denominator counting a phoneme override's inner space as a word, landing every reveal early.
    const raw = rawBoard();
    raw.beats[1]!.spoken = "[First](/fˈɜːst ɹ/) row, then the second row.";
    const extras = listExtras([{ target: "rows-1", atCue: "then" }]);

    const timeline = compileTimeline(StoryboardSchema.parse(raw), undefined, { extras });

    expect(timeline.beats[1]?.reveals?.[0]?.atS).toBeCloseTo((2 / 6) * 5, 9);
  });

  it("refuses a reveal whose cue is never spoken, naming the beat, voiced or not", () => {
    const extras = listExtras([{ target: "rows-1", atCue: "zebra" }]);

    const voiced = () => compileTimeline(board(), words(), { extras });
    const planned = () => compileTimeline(board(), undefined, { extras });

    expect(voiced).toThrow('cue "zebra" is not spoken in beat-02');
    expect(planned).toThrow('cue "zebra" is not spoken in beat-02');
  });

  it("writes the same bytes as before page extras existed when none are given", () => {
    const cues = { "beat-01": ["fail"], "beat-02": ["row#2", "then"] };

    const voiced = readFileSync(writeTimeline(scratch(), compileTimeline(board(cues), words())));
    const planned = readFileSync(writeTimeline(scratch(), compileTimeline(board(cues))));

    expect([sha256(voiced), sha256(planned)]).toEqual([
      "1f1c680b7c3b0b1f17b325cb5aa91180e6f749645fabeec14f0820340eb609c7",
      "52addf4758d29e4542dda75f02dd8e684c48fc01e90b1cbc9eae0bf7ba0f938e",
    ]);
  });
});

describe("storyboard cues", () => {
  const withCue = (cue: string) => StoryboardSchema.safeParse(rawBoard({ "beat-01": [cue] })).success;

  it("rejects word#0 and a cue of two words, and accepts word#2", () => {
    const verdicts = [withCue("word#0"), withCue("two words"), withCue("word#2")];

    expect(verdicts).toEqual([false, false, true]);
  });
});
