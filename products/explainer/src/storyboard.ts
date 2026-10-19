import { z } from "zod";

// Beat types and video types stay open kebab-case strings: the doctrine registry (beats/<type>.yaml,
// types/<video-type>.yaml) is the source of the allowed values, and it validates them at load time.
const kebab = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "expected kebab-case");

const BEAT_ID = /^beat-(\d+)$/;

/** The number a `beat-NN` id names, so `beat-03` and `beat-3` are the same beat and `beat-30` is not. */
export function beatNumber(id: string): number | undefined {
  const match = BEAT_ID.exec(id);
  return match ? Number(match[1]) : undefined;
}

const BeatSchema = z
  .object({
    id: z.string().regex(BEAT_ID, "expected beat-NN"),
    type: kebab,
    // A visual-router type id (doctrine/visual-router.json); the packet carries that type's card.
    kind: kebab.optional(),
    chapter: kebab.optional(),
    duration_s: z.number().positive(),
    // Seconds from the beat start. A format change adds an optional field, never a version bump alone.
    stops: z.array(z.number().nonnegative()).optional(),
    spoken: z.string().min(1),
    display: z.string().min(1).optional(),
    slots: z.record(z.string(), z.unknown()).default({}),
    sources: z.array(z.string().min(1)).default([]),
  })
  .superRefine((beat, ctx) => {
    const stops = beat.stops ?? [];
    stops.forEach((stop, i) => {
      if (stop > beat.duration_s) ctx.addIssue({ code: "custom", path: ["stops", i], message: "stop past the beat's duration" });
      if (i > 0 && stop <= (stops[i - 1] ?? 0)) ctx.addIssue({ code: "custom", path: ["stops", i], message: "stops must ascend" });
    });
  });

const ChapterSchema = z.object({ id: kebab, title: z.string().min(1) });

/** `beats.json`: the plan step's output, one storyboard of beats for one video type. */
export const StoryboardSchema = z
  .object({
    video_type: kebab,
    title: z.string().min(1),
    chapters: z.array(ChapterSchema).default([]),
    beats: z.array(BeatSchema).min(1),
  })
  .superRefine((board, ctx) => {
    const numbers = new Set<number | undefined>();
    const chapters = new Set(board.chapters.map((c) => c.id));
    board.beats.forEach((beat, i) => {
      const n = beatNumber(beat.id);
      if (numbers.has(n)) ctx.addIssue({ code: "custom", path: ["beats", i, "id"], message: `duplicate beat number in ${beat.id}` });
      numbers.add(n);
      if (beat.chapter && !chapters.has(beat.chapter)) {
        ctx.addIssue({ code: "custom", path: ["beats", i, "chapter"], message: `unknown chapter ${beat.chapter}` });
      }
    });
  });

export type Storyboard = z.infer<typeof StoryboardSchema>;
export type Beat = Storyboard["beats"][number];
