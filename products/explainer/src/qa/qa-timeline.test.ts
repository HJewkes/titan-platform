import { describe, expect, it } from "vitest";
import { choppy } from "../rewrite-fixtures.test-helpers.js";
import { qaCues, qaMoments, timelineFromArtifact, timelineFromWords, timelineS } from "./qa-timeline.js";

/** Every beat of the synthetic script spoken one word each half second, after a 0.25 s lead. */
function wordsOf(script: ReturnType<typeof choppy>) {
  const beats = script.beats.map((beat) => {
    const words = beat.spoken.split(/\s+/).map((word, i) => ({ word, start: 0.25 + i * 0.5 }));
    return { id: beat.id, durationS: 0.5 + words.length * 0.5, words };
  });
  return { beats };
}

describe("QA timeline", () => {
  it("builds the same moments from words and script as from the render's timeline when they agree", () => {
    const script = choppy({ h1: { visual: { assertion: "The desk refuses unknown parcels", job: "numbers", beat: "list", cues: [{ action: "V6", target: "rows-1", atCue: "courier" }] } } });
    const words = wordsOf(script);
    const courierS = words.beats.find((beat) => beat.id === "h1")!.words.find((w) => w.word.toLowerCase().startsWith("courier"))!.start;
    let startS = 0;
    const beats = words.beats.map(({ id, durationS }) => {
      const beat = { id, kind: "list", startS, durationS, slots: {}, ...(id === "h1" ? { cues: { courier: courierS } } : {}) };
      startS += durationS;
      return beat;
    });
    const given = timelineFromArtifact({ durationS: startS, beats });

    const derived = timelineFromWords(words, script);

    expect(qaMoments(derived)).toEqual(qaMoments(given));
    expect(qaCues(derived)).toEqual([{ beat: "h1", word: "courier", nth: 1, atS: courierS }]);
    expect(timelineS(derived)).toBeCloseTo(startS);
  });

  it("leaves out a beat resolve cut, keeping the beats after it at their spoken start", () => {
    const script = choppy();
    const words = wordsOf(script);
    const [first, cut, third] = words.beats;

    const timeline = timelineFromWords(words, script, { cut: [{ id: cut!.id, chapter: "c", code: "sim", detail: "cut" }] });

    expect(timeline.beats.slice(0, 2).map((beat) => [beat.id, beat.startS])).toEqual([[first!.id, 0], [third!.id, first!.durationS + cut!.durationS]]);
  });
});
