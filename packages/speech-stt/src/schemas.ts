import { z } from "zod";

/** Mono PCM: one float per sample, nominally in [-1, 1]. */
export interface Audio {
  samples: Float32Array;
  sampleRate: number;
}

/** One recognised or aligned word. Times are seconds from the start of the audio. */
export const WordSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  probability: z.number().optional(),
});
export type Word = z.infer<typeof WordSchema>;

/** A recogniser segment. The confidence fields are optional because not every backend reports them. */
export const SegmentSchema = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  avgLogprob: z.number().optional(),
  compressionRatio: z.number().optional(),
  noSpeechProb: z.number().optional(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const TranscriptSchema = z.object({
  text: z.string(),
  words: z.array(WordSchema),
  segments: z.array(SegmentSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;
