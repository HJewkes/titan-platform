import { z } from "zod";
import type { WordTiming } from "./cues.js";

/** One beat's heard length, and its word starts when the file carries them. */
export interface BeatTiming {
  durationS: number;
  words?: WordTiming[];
}

/** Heard timings keyed by beat id; a beat missing from the map was never voiced. */
export type ScriptTiming = ReadonlyMap<string, BeatTiming>;

// Loose on purpose: a TTS words.json carries voice, speed and density fields the pace layer never reads, and a
// durations-only extract drops `words` altogether.
const WordsFileSchema = z.object({
  beats: z.array(
    z.object({
      id: z.string().min(1),
      durationS: z.number().positive(),
      words: z.array(z.object({ word: z.string(), start: z.number().nonnegative() })).optional(),
    }),
  ),
});

/** Reads a spike words.json (or its durations-only extract) into per-beat heard timings. */
export function readTiming(json: unknown): ScriptTiming {
  const { beats } = WordsFileSchema.parse(json);
  return new Map(
    beats.map(({ id, durationS, words }) => [
      id,
      words ? { durationS, words: words.map(({ word, start }) => ({ word, startS: start })) } : { durationS },
    ]),
  );
}
