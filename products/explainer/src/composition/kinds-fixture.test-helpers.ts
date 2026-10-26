import { readFileSync } from "node:fs";
import { beatIdMap } from "../render/beat-ids.js";
import { boardFromFill } from "../render/board-from-fill.js";
import { compileTimeline } from "../render/compile-timeline.js";
import { resolveBeats } from "../resolve-beat.js";
import { shippedRouter, shippedSpecs } from "../resolve-fixtures.test-helpers.js";
import { ScriptSchema } from "../script-schema.js";
import { fillScript } from "../template-fill/fill.js";
import type { TimelineBeat } from "./timeline.js";

// Synthetic: an invented factory floor in five chapters; nothing here quotes a real run, repo or script.
const SCRIPT = new URL("./fixtures/kinds.script.json", import.meta.url);
/** Even synthetic speech: every word this long, the first after a short lead-in, and a tail after the last. */
const WORD_S = 0.35;
const LEAD_IN_S = 0.2;
const TAIL_S = 0.8;

function syntheticWords(beats: readonly { id: string; spoken: string }[]) {
  return {
    beats: beats.map(({ id, spoken }) => {
      const words = spoken.split(/\s+/).map((word, i) => ({ word, start: Number((LEAD_IN_S + i * WORD_S).toFixed(2)) }));
      return { id, durationS: Number((LEAD_IN_S + words.length * WORD_S + TAIL_S).toFixed(2)), words };
    }),
  };
}

/**
 * The daily beats of kinds.timeline.json: the synthetic daily script through resolve, the template fill,
 * boardFromFill and compileTimeline over even synthetic words, so every slot, reveal, chip and hint is real fill
 * output. Shifted to start at `startS`, after the fixture's hand-written page and held beats.
 */
export function dailyKindBeats(startS: number): TimelineBeat[] {
  const script = ScriptSchema.parse(JSON.parse(readFileSync(SCRIPT, "utf8")));
  const resolved = { beats: resolveBeats(script.beats, shippedSpecs, shippedRouter) };
  const filled = fillScript(script, resolved, { specs: shippedSpecs });
  const ids = beatIdMap(script.beats.map((beat) => beat.id));
  const { board, extras } = boardFromFill(script, filled, ids);
  const words = syntheticWords(board.beats);
  const timeline = compileTimeline(board, words, { extras });
  // Summed as compileTimeline sums them, so each beat ends exactly where the next starts.
  let at = startS;
  return timeline.beats.map((beat) => {
    const shifted = { ...beat, startS: at };
    at += beat.durationS;
    return shifted;
  });
}
