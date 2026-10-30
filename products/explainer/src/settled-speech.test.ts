import { describe, expect, it } from "vitest";
import { dailyWith } from "./daily-script.test-helpers.js";
import { scriptPacing } from "./lint-cadence.js";
import { stillBeats } from "./lint-still.js";
import { staticWindow, timingProfile, type TimingInput } from "./qa/timing-gates.js";
import type { ScriptV1 } from "./script-schema.js";

const FPS = 30;
const MOVING = 0.02;

/** A 10 s beat that moves on every frame except a still run from 1 s lasting `stillS`. */
const stillFrom1 = (stillS: number) =>
  Array.from({ length: 10 * FPS }, (_, n) => (n > FPS && n <= FPS + Math.round(stillS * FPS) ? 0 : MOVING));

/** Word starts every 0.4 s from 0.3 s up to `untilS`: the narration speaks over that span. */
const speechUntil = (untilS: number) => {
  const words = Array.from({ length: Math.floor((untilS - 0.3) / 0.4) + 1 }, (_, i) => ({ word: `w${i}`, startS: 0.3 + i * 0.4 }));
  return new Map([["b1", { durationS: 10, words }]]);
};

function qaInput(stillS: number, reveals: number[], speechEndS: number): TimingInput {
  const timeline = { beats: [{ id: "b1", startS: 0, durationS: 10, cues: [], reveals }] };
  return { timeline, words: speechUntil(speechEndS), held: new Set(), diffs: stillFrom1(stillS), fps: FPS, probed: [], profile: timingProfile() };
}

/** A custom layer's 5 s still run from 1 s under speech to 9 s, with cue words at `cueAtS`. */
function customInput(cueAtS: readonly number[]): TimingInput {
  const input = qaInput(5, [], 9);
  const cues = cueAtS.map((atS, i) => ({ name: `word${i}`, atS }));
  return { ...input, timeline: { beats: input.timeline.beats.map((beat) => ({ ...beat, layer: "custom" as const, cues })) } };
}

describe("static-window excuses a settled frame under speech, up to 6 s", () => {
  it("passes a 5 s still run once every element is revealed and the voice speaks over it", () => {
    const gate = staticWindow(qaInput(5, [0.2, 0.6], 9));

    expect(gate.pass).toBe(true);
  });

  it("fails a 5 s still run while an element is still to be revealed", () => {
    const gate = staticWindow(qaInput(5, [0.2, 0.6, 7], 9));

    expect(gate).toMatchObject({ pass: false, value: 5, beats: ["b1"] });
  });

  it("fails a settled still run past 6 s even under speech", () => {
    const gate = staticWindow(qaInput(7, [0.2], 9.5));

    expect(gate).toMatchObject({ pass: false, value: 7 });
  });

  it("fails a settled 5 s still run the voice is silent over", () => {
    const gate = staticWindow(qaInput(5, [0.2], 1));

    expect(gate).toMatchObject({ pass: false, value: 5 });
  });

  // catches: the excusal stopping at custom layers, against owner decision vc-6 (TP-4611)
  it("passes a custom layer's 5 s still run after its last cue while the voice speaks", () => {
    const input = customInput([0.2, 0.8]);

    const gate = staticWindow(input);

    expect(gate.pass).toBe(true);
  });

  // catches: a custom layer settling at its cut, so a layer waiting on a cue stands still past 3 s
  it("fails a custom layer's 5 s still run before its last cue", () => {
    const input = customInput([0.2, 7]);

    const gate = staticWindow(input);

    expect(gate).toMatchObject({ pass: false, value: 5, beats: ["b1"] });
  });
});

// Every row's words are spoken, so no reading hold breaks a stretch; the rows land on "merged" and on the cue given.
const SAID = "What did each lane move? In lanes, router merged its matcher rewrite and kept the old path behind a switch.";
const SAID_ROWS = ["router · Matcher rewrite merged", "router · Kept the old path", "router · Behind a switch"];
const cue = (target: string, atCue: string) => ({ action: "V6" as const, target, atCue });
const lane = (more: string, lastCue: string) =>
  dailyWith("lanes-1", { spoken: `${SAID} ${more}`, visual: { assertion: "Router merged its matcher", labels: SAID_ROWS, cues: [cue("rows-2", "merged"), cue("rows-3", lastCue)] } });
const customLane = (more: string, lastCue: string) =>
  dailyWith("lanes-1", { spoken: `${SAID} ${more}`, visual: { beat: "kanban-flow", layer: "custom", assertion: "Router merged its matcher", labels: SAID_ROWS, cues: [cue("rows-2", "merged"), cue("rows-3", lastCue)] } });
const stillOf = (script: ScriptV1, id: string, staticMaxS?: number) => {
  const pacing = scriptPacing(script)!;
  return stillBeats(script, { ...pacing, staticMaxS: staticMaxS ?? pacing.staticMaxS }).find(({ beat }) => beat.id === id)?.stretches ?? [];
};
const lengths = (stretches: readonly { fromS: number; toS: number }[]) => stretches.map(({ fromS, toS }) => Number((toS - fromS).toFixed(1)));

describe("Q-D22 excuses a settled frame under speech, up to 6 s, as static-window does", () => {
  it("passes a 5.4 s stretch after the last reveal while the voice speaks", () => {
    const script = lane("The switch stays on tonight.", "kept");

    const found = stillOf(script, "lanes-1");

    expect(found).toEqual([]);
  });

  it("fails a 5.2 s stretch between reveals", () => {
    const script = lane("The switch stays on through the night and the morning shift.", "through");

    const found = stillOf(script, "lanes-1");

    expect(found).toMatchObject([{ after: "merged" }]);
    expect(lengths(found)).toEqual([5.2]);
  });

  it("fails a 7.2 s stretch after the last reveal even while the voice speaks", () => {
    const script = lane("The switch stays on through the night and the morning.", "kept");

    const found = stillOf(script, "lanes-1");

    expect(found).toMatchObject([{ after: "kept" }]);
    expect(lengths(found)).toEqual([7.2]);
  });

  // catches: Q-D22 refusing at script time a custom layer qa now excuses (vc-6, TP-4611)
  it("passes a custom layer's stretch after its last cue while the voice speaks", () => {
    const script = customLane("The switch stays on tonight.", "kept");

    const found = stillOf(script, "lanes-1");

    expect(found).toEqual([]);
  });

  // catches: the excusal reaching a custom layer still waiting on a cue
  it("fails a custom layer's stretch before its last cue", () => {
    const script = customLane("The switch stays on through the night and the morning shift.", "through");

    const found = stillOf(script, "lanes-1");

    expect(found).toMatchObject([{ after: "merged" }]);
  });

  // The truing settle keeps a voiced beat's silence under 3 s, so a 2 s line shows the silent part held to staticMaxS.
  it("holds the part of a settled stretch the voice is silent over to staticMaxS", () => {
    const card = (spoken: string) => dailyWith("reflection-2", { plannedS: 8, spoken, visual: { assertion: "Small lanes win", labels: ["Small lanes win"] } });
    const silent = card("Small lanes win.");
    const spoken = card("Small lanes win, and today the floor showed it again across every lane.");

    const found = [stillOf(silent, "reflection-2", 2), stillOf(spoken, "reflection-2", 2)];

    expect(found.map(lengths)).toEqual([[3], []]);
  });
});
