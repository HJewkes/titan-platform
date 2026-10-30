import { changedShare } from "@titan-design/render-qa";
import type { LayerTextRow, LayerTimingRule } from "../build/layer-text.js";
import { longLabels, pictureChange, shortReads, staticStretches, type TimingInput } from "./timing-gates.js";

/**
 * qa's beat-local timing gates on one custom layer (TP-4611), from qa's own functions over the layer's frames. Ten frames
 * a second stand in for the MP4's framediff, which needs a render: a still stretch reads within a tenth of a second, and
 * only a change too slow to pass the static level frame by frame reads as motion here and as still in qa.
 */
export const LAYER_DIFF_FPS = 10;

const seconds = (s: number): string => s.toFixed(1);

/** Each timing gate qa's stage fails on a layer can break, as the rows a rebuild is told. */
const LAYER_TIMING_RUNS: Record<LayerTimingRule, (beat: string, input: TimingInput) => LayerTextRow[]> = {
  "static-window": (beat, input) =>
    staticStretches(input).map(({ fromS, s }) => ({ beat, element: "frame", rule: "static-window", text: `still for ${seconds(s)} s, from ${seconds(fromS)} s to ${seconds(fromS + s)} s of the beat`, atS: fromS })),
  "picture-change": (beat, input) => {
    const { pass, value, threshold } = pictureChange(input);
    return pass ? [] : [{ beat, element: "frame", rule: "picture-change", text: `${seconds(value ?? 0)} s between cue-driven changes, ${threshold}`, atS: 0 }];
  },
  "reading-hold": (beat, input) => shortReads(input).map(({ element, text, fromS }) => ({ beat, element, rule: "reading-hold", text, atS: fromS })),
  G9: (beat, input) => longLabels(input).map(({ element, text }) => ({ beat, element, rule: "G9", text, atS: 0 })),
};

/** How each gate in qa's `TIMING_GATES` reaches a layer: `timing` here, `text` a row of its own, `voice` nothing the layer draws. */
export const QA_TIMING_GATE_COVER: Readonly<Record<string, "timing" | "text" | "voice">> = {
  "picture-change": "timing",
  "static-window": "timing",
  "reading-hold": "timing",
  G9: "timing",
  G10: "text",
  "words-per-frame": "text",
  "cue-onset": "voice",
};

export const LAYER_TIMING_RULES = Object.keys(LAYER_TIMING_RUNS) as LayerTimingRule[];

/** Every timing row of one layer on its one-beat timeline. */
export const layerTimingRows = (beat: string, input: TimingInput): LayerTextRow[] => LAYER_TIMING_RULES.flatMap((rule) => LAYER_TIMING_RUNS[rule](beat, input));

const round3 = (s: number): number => Math.round(s * 1000) / 1000;

/** The evenly spaced seconds of a beat whose frames the gates read. */
export const layerDiffTimes = (durationS: number): number[] => Array.from({ length: Math.ceil(durationS * LAYER_DIFF_FPS) }, (_, i) => round3(i / LAYER_DIFF_FPS));

/** The share of pixels each frame changed from the one before, as qa's framediff gives it. `grey` is the frame at a second. */
export const shareAfterPrevious = (times: readonly number[], grey: (t: number) => Uint8Array): number[] =>
  times.map((t, i) => (i === 0 ? 0 : changedShare(grey(times[i - 1]!), grey(t))));
