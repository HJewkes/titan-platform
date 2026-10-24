import { z } from "zod";

const Kebab = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a kebab-case name");

/**
 * One step of a beat system: the vocabulary beats that may play it, and what it does. An optional
 * step is the one a structure may drop, as the decision brief drops the CL order's problem row.
 */
const BeatSystemStepSchema = z
  .object({ beats: z.array(Kebab).min(1), does: z.string().min(1), optional: z.boolean().optional() })
  .strict();

/**
 * One per-type beat system (video-profiles plan §B, slice 3): an ordered beat pattern that plays
 * inside a structure's blocks. The structure owns the macro shape; the system owns the beat order
 * within it, so one system may serve several structures and a block-scoped system nests in another.
 */
export const BeatSystemSchema = z
  .object({
    schema: z.literal("beat-system/v1"),
    id: Kebab,
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "expected a semver version"),
    source: z.string().min(1),
    summary: z.string().min(1),
    steps: z.array(BeatSystemStepSchema).min(2),
  })
  .strict();

export type BeatSystem = z.infer<typeof BeatSystemSchema>;
export type BeatSystemStep = z.infer<typeof BeatSystemStepSchema>;

/** A block a step can land in: its id and the beats it allows. */
export interface PlacementBlock {
  id: string;
  beats: readonly string[];
}

export interface BeatSystemPlacement {
  placed: { step: number; block: string }[];
  unplaced: number[];
}

/**
 * Lands each step, in order, in the earliest block at or after the previous step's block that
 * allows one of its beats. A required step that cannot land is unplaced; an optional one is skipped.
 */
export function placeBeatSystem(system: BeatSystem, blocks: readonly PlacementBlock[]): BeatSystemPlacement {
  const result: BeatSystemPlacement = { placed: [], unplaced: [] };
  let cursor = 0;
  system.steps.forEach((step, i) => {
    const at = blocks.findIndex((block, b) => b >= cursor && step.beats.some((beat) => block.beats.includes(beat)));
    if (at >= 0) {
      cursor = at;
      result.placed.push({ step: i, block: blocks[at]!.id });
    } else if (step.optional !== true) {
      result.unplaced.push(i);
    }
  });
  return result;
}
