import type { ProbedMoment } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { earlyReveal, holdThroughReference, textSpans } from "./reference-timing.js";
import { TIMING_GATES, timingProfile, timingReport, type TimingInput } from "./timing-gates.js";

/** Three sentences, one word every 0.5 s from 0.5 s: "cache" opens the third, at 4.5 s. */
const NARRATION = "The queue holds jobs. Workers pull from it. Cache answers repeats.";
const said = NARRATION.split(" ").map((word, i) => ({ word, startS: 0.5 + i * 0.5 }));

const text = (value: string, element: string) => ({ text: value, px: 64, tag: "div", cls: "label", element, lines: [], clips: [] });
const moment = (t: number, texts: [string, string][]): ProbedMoment => ({ beat: "b1", t, texts: texts.map(([v, el]) => text(v, el)), boxes: [] });

/** A 2 Hz probe over 8 s that shows `value` in `element` from `fromS` until `untilS`. */
function shown(value: string, element: string, fromS: number, untilS = 8): ProbedMoment[] {
  return Array.from({ length: 17 }, (_, i) => i * 0.5).map((t) => moment(t, t >= fromS && t < untilS ? [[value, element]] : []));
}

function input(probed: ProbedMoment[], cues: { name: string; atS: number }[] = []): TimingInput {
  const timeline = { beats: [{ id: "b1", startS: 0, durationS: 8, cues }] };
  return { timeline, words: new Map([["b1", { durationS: 8, words: said }]]), held: new Set(), diffs: [], fps: 30, probed, profile: timingProfile() };
}

describe("early-reveal", () => {
  const cache = [{ name: "cache", atS: 4.5 }];

  it("flags an element that shows two sentences before its cue word", () => {
    const probed = shown("Cache", "div.cache", 0.5);

    const gate = earlyReveal(input(probed, cache));

    expect(gate).toMatchObject({ value: 1, pass: false, beats: ["b1"] });
  });

  it("passes an element that shows during the sentence before its cue word", () => {
    const probed = shown("Cache", "div.cache", 3);

    const gate = earlyReveal(input(probed, cache));

    expect(gate).toMatchObject({ value: 0, pass: true });
  });

  it("passes an element shown at the cut when its cue is in the beat's second sentence", () => {
    const probed = shown("Workers", "div.workers", 0);

    const gate = earlyReveal(input(probed, [{ name: "workers", atS: 2.5 }]));

    expect(gate.pass).toBe(true);
  });

  it("leaves elements that do not hold the cue word alone", () => {
    const probed = shown("Queue", "div.queue", 0);

    const gate = earlyReveal(input(probed, cache));

    expect(gate.pass).toBe(true);
  });
});

describe("hold-through-reference", () => {
  it("flags a label removed while the narration still names it", () => {
    const probed = shown("Workers", "div.workers", 1, 2.5);

    const gate = holdThroughReference(input(probed));

    expect(gate).toMatchObject({ value: 1, pass: false, beats: ["b1"] });
  });

  it("flags a label removed less than half a second after its last referring word ends", () => {
    const probed = shown("Workers", "div.workers", 1, 3);

    const gate = holdThroughReference(input(probed));

    expect(gate.pass).toBe(false);
  });

  it("passes a label held half a second past its last referring word", () => {
    const probed = shown("Workers", "div.workers", 1, 3.5);

    const gate = holdThroughReference(input(probed));

    expect(gate.pass).toBe(true);
  });

  it("does not count common words as the narration referring to an element", () => {
    const probed = shown("The plan", "div.plan", 0, 1);

    const gate = holdThroughReference(input(probed));

    expect(gate.pass).toBe(true);
  });

  it("passes an element the narration never names", () => {
    const probed = shown("Latency", "div.latency", 0, 1);

    const gate = holdThroughReference(input(probed));

    expect(gate.pass).toBe(true);
  });
});

describe("timing report", () => {
  it("reports early-reveal and hold-through-reference without gating the qa stage on them", () => {
    const probed = shown("Cache", "div.cache", 0.5, 4.6);

    const { gates } = timingReport(input(probed, [{ name: "cache", atS: 4.5 }]));

    const ids = gates.filter((g) => !g.pass).map((g) => g.id);
    expect(ids).toEqual(expect.arrayContaining(["early-reveal", "hold-through-reference"]));
    expect(TIMING_GATES).not.toContain("early-reveal");
    expect(TIMING_GATES).not.toContain("hold-through-reference");
  });
});

describe("text spans", () => {
  const counting = (value: string, t: number): ProbedMoment => moment(t, [[value, "div.tile"]]);

  it("a number counting up in one element is one reading span", () => {
    // Arrange
    const probed = [counting("5", 0), counting("19", 0.5), counting("32", 1), moment(1.5, [])];

    // Act
    const spans = textSpans(probed);

    // Assert
    expect(spans).toEqual([expect.objectContaining({ text: "32", fromS: 0, untilS: 1.5 })]);
  });

  it("sibling numbers sharing an element description keep separate spans", () => {
    const probed = [moment(0, [["12", "span.fig"], ["40", "span.fig"]]), moment(1, [])];

    const spans = textSpans(probed);

    expect(spans.map((s) => s.text)).toEqual(["12", "40"]);
  });

  it("words replacing words in one element stay separate spans", () => {
    const probed = [moment(0, [["Queue", "div.t"]]), moment(0.5, [["Cache", "div.t"]]), moment(1, [])];

    const spans = textSpans(probed);

    expect(spans.map((s) => s.text)).toEqual(["Queue", "Cache"]);
  });
});
