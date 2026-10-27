import type { ProbedMoment } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { fixedProfile } from "../profile-fixtures.test-helpers.js";
import { cueOnset, g8TextSize, pictureChange, readingHold, staticWindow, TEXT_FLOOR_PX, timingProfile, timingReport, type TimingInput } from "./timing-gates.js";

const FPS = 30;
const MOVING = 0.02;

/** Every frame of `seconds` changes, except the frames `still` names. */
const diffs = (seconds: number, still: (frame: number) => boolean = () => false) =>
  Array.from({ length: Math.round(seconds * FPS) }, (_, n) => (n > 0 && still(n) ? 0 : MOVING));

const beat = (id: string, startS: number, durationS: number, cues: { name: string; atS: number }[] = []) => ({ id, startS, durationS, cues });

/** One synthetic 4 s beat that moves on every frame, with no cues, words or text: every gate passes it. */
function input(over: Partial<TimingInput> = {}): TimingInput {
  return { timeline: { beats: [beat("b1", 0, 4)] }, words: new Map(), held: new Set(), diffs: diffs(4), fps: FPS, probed: [], profile: timingProfile(), ...over };
}

const text = (value: string, px = 64) => ({ text: value, px, tag: "div", cls: "label", element: "div.label", lines: [], clips: [] });
const moment = (t: number, texts: string[]): ProbedMoment => ({ beat: "b1", t, texts: texts.map((value) => text(value)), boxes: [] });

/** A still picture of `frames` frames starting at 1 s, inside an 8 s beat that otherwise moves. */
const stillFor = (frames: number) => diffs(8, (n) => n > FPS && n <= FPS + frames);

describe("picture-change gate", () => {
  it("fails a 9 s gap between cue-driven changes", () => {
    const gate = pictureChange(input({ timeline: { beats: [beat("b1", 0, 9)] }, diffs: diffs(9) }));

    expect(gate).toMatchObject({ value: 9, pass: false, warn: true, beats: ["b1"] });
  });

  it("warns on a 6 s gap without failing it", () => {
    const gate = pictureChange(input({ timeline: { beats: [beat("b1", 0, 6)] }, diffs: diffs(6) }));

    expect(gate).toMatchObject({ value: 6, pass: true, warn: true });
  });

  it("counts a cue as a change only when its frames move", () => {
    const timeline = { beats: [beat("b1", 0, 12, [{ name: "desk", atS: 6 }])] };

    const moved = pictureChange(input({ timeline, diffs: diffs(12) }));
    const still = pictureChange(input({ timeline, diffs: diffs(12, (n) => n >= 5 * FPS && n <= 7 * FPS) }));

    expect(moved).toMatchObject({ value: 6, pass: true });
    expect(still).toMatchObject({ value: 12, pass: false });
  });
});

describe("static-window gate", () => {
  const eight = { beats: [beat("b1", 0, 8)] };

  it.each([
    ["fails", "3.1 s", 93, false],
    ["passes", "3.0 s", 90, true],
  ])("%s a %s still picture outside any hold", (_verdict, _len, frames, pass) => {
    const gate = staticWindow(input({ timeline: eight, diffs: stillFor(frames) }));

    expect(gate).toMatchObject({ value: frames / FPS, pass, beats: pass ? [] : ["b1"] });
  });

  it("excuses a still picture inside a declared held beat", () => {
    const gate = staticWindow(input({ timeline: eight, diffs: stillFor(93), held: new Set(["b1"]) }));

    expect(gate.pass).toBe(true);
  });

  it("excuses a still picture while an unspoken text is being read", () => {
    const label = "Forty scans a minute reach the desk server";
    const probed = [moment(0.5, []), moment(1, [label]), moment(5, [label]), moment(6, [])];

    const gate = staticWindow(input({ timeline: eight, diffs: stillFor(93), probed }));

    expect(gate.pass).toBe(true);
  });

  it("reads its line from the profile, so a profile allowing 4 s passes the 3.1 s picture", () => {
    const base = fixedProfile();
    const lax = fixedProfile({ pacing: { ...base.pacing, staticMaxS: 4 } });

    const strict = staticWindow(input({ timeline: eight, diffs: stillFor(93), profile: timingProfile(base) }));
    const loose = staticWindow(input({ timeline: eight, diffs: stillFor(93), profile: timingProfile(lax) }));

    expect([strict.pass, loose.pass]).toEqual([false, true]);
  });

  it("counts each over-long still picture in the report", () => {
    const twice = diffs(12, (n) => (n > FPS && n <= FPS + 93) || (n > 6 * FPS && n <= 6 * FPS + 100));

    const report = timingReport(input({ timeline: { beats: [beat("b1", 0, 12)] }, diffs: twice }));

    expect(report.static_window_count).toBe(2);
  });
});

describe("cue-onset gate", () => {
  const words = new Map([["b1", { durationS: 4, words: [{ word: "Scan", startS: 2 }] }]]);

  it.each([
    ["fails", 2.31, false],
    ["passes", 2.3, true],
    ["passes", 1.7, true],
  ])("%s a cue at %s s against its word at 2 s", (_verdict, atS, pass) => {
    const gate = cueOnset(input({ timeline: { beats: [beat("b1", 0, 4, [{ name: "scan", atS }])] }, words }));

    expect(gate.pass).toBe(pass);
  });

  it("fails a cue on a word the voice never spoke", () => {
    const gate = cueOnset(input({ timeline: { beats: [beat("b1", 0, 4, [{ name: "ledger", atS: 1 }])] }, words }));

    expect(gate).toMatchObject({ pass: false, beats: ["b1"] });
  });
});

describe("reading-hold gate", () => {
  /** 25 characters: it needs 25 / 13 = 1.92 s on screen. */
  const LABEL = "Parcel desk scanner queue";

  it.each([
    ["fails", "leaves after 1.5 s", 2.5, false],
    ["passes", "stays 2 s", 3, true],
  ])("%s a label no one speaks that %s", (_verdict, _how, goneS, pass) => {
    const probed = [moment(0.5, []), moment(1, [LABEL]), moment(1.5, [LABEL]), moment(goneS, [])];

    const gate = readingHold(input({ probed }));

    expect(gate).toMatchObject({ pass, beats: pass ? [] : ["b1"] });
  });

  it("holds a short label for the 1.5 s floor, not its character count", () => {
    const probed = [moment(1, ["Dock 4"]), moment(2, [])];

    const gate = readingHold(input({ probed }));

    expect(gate.pass).toBe(false);
  });

  it("lets a label the narration speaks while it shows leave early", () => {
    const said = ["Parcel", "desk", "scanner", "queue"].map((word, i) => ({ word, startS: 1 + i * 0.3 }));
    const probed = [moment(1, [LABEL]), moment(2.5, [])];

    const gate = readingHold(input({ probed, words: new Map([["b1", { durationS: 4, words: said }]]) }));

    expect(gate.pass).toBe(true);
  });
});

describe("G8 text size", () => {
  it("fails 28 px text now that the type floor is 40 px", () => {
    const probed: ProbedMoment[] = [{ beat: "b", t: 1, texts: [{ ...text("chip", 28), tag: "li" }, { ...text("Headline", 96), tag: "h1" }], boxes: [] }];

    const gate = g8TextSize({ probed });

    expect(TEXT_FLOOR_PX).toBe(40);
    expect(gate.pass).toBe(false);
    expect(gate.threshold).toMatch(/≥ 40 px/);
  });
});

describe("G10 shared words", () => {
  const said = "the desk reads the parcel row first".split(" ").map((word, i) => ({ word, startS: i * 0.4 }));
  const words = new Map([["b1", { durationS: 4, words: said }]]);

  it.each([
    ["fails", "Desk reads the parcel row", false],
    ["passes", "Parcel row first", true],
  ])("%s display text %j against the beat's narration", (_verdict, display, pass) => {
    const gate = timingReport(input({ words, probed: [moment(1, [display])] })).gates.find((g) => g.id === "G10");

    expect(gate?.pass).toBe(pass);
  });
});

const gateOf = (over: Partial<TimingInput>, id: string) => timingReport(input(over)).gates.find((g) => g.id === id);

describe("G9 headline and label words", () => {
  it.each([
    ["fails", "h1", "", "One two three four five six seven eight nine ten eleven", false],
    ["passes", "h1", "", "One two three four five six seven eight nine ten", true],
    ["fails", "span", "label", "four words on chip", false],
    ["passes", "span", "label", "three word chip", true],
  ])("%s a %s.%s holding %j", (_verdict, tag, cls, value, pass) => {
    const probed: ProbedMoment[] = [{ beat: "b1", t: 1, texts: [{ ...text(value), tag, cls }], boxes: [] }];

    const gate = gateOf({ probed }, "G9");

    expect(gate?.pass).toBe(pass);
  });
});

describe("words-per-frame", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

  it.each([
    ["fails", 21, false],
    ["passes", 20, true],
  ])("%s %i prose words on screen together across texts", (_verdict, n, pass) => {
    const probed = [moment(1, [many(10), many(n - 10)])];

    const gate = gateOf({ probed }, "words-per-frame");

    expect(gate).toMatchObject({ value: n, pass, beats: pass ? [] : ["b1"] });
  });

  it("leaves a code-walk beat's highlighted lines out of the count", () => {
    const timeline = { beats: [{ ...beat("b1", 0, 4), kind: "code-walk" }] };
    const codeLine = { ...text(many(40)), tag: "span", cls: "tok-kw", element: "span.tok-kw" };
    const probed: ProbedMoment[] = [{ beat: "b1", t: 1, texts: [codeLine], boxes: [] }];

    const gate = gateOf({ timeline, probed }, "words-per-frame");

    expect(gate).toMatchObject({ value: null, pass: true });
  });
});
