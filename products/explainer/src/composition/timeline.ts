import { z } from "zod";
import { ANCHOR_SPEC_PATTERN } from "../anchor-grid.js";

/** When one slot element lands, in seconds from the beat's start: its cue word, resolved by compileTimeline. */
const RevealSchema = z.object({ target: z.string().min(1), part: z.enum(["left", "right"]).optional(), atS: z.number().min(0) });

/** When a cue names an element again after it landed (or an edge, or a claim), in beat seconds: the view lights it. */
const EmphasisSchema = z.object({ target: z.string().min(1), atS: z.number().min(0) });

/** The fill's page hints (template-fill FillHints); none of them is a slot. */
const HintsSchema = z.object({
  placeholder: z.literal(true).optional(),
  headingYields: z.literal(true).optional(),
  qaLeadLine: z.literal(true).optional(),
  continues: z.string().min(1).optional(),
  titleOmitted: z.literal(true).optional(),
});

const ChapterSchema = z
  .object({ n: z.number().int().positive(), of: z.number().int().positive(), label: z.string().min(1) })
  .refine((c) => c.n <= c.of, { message: "a chapter's n must not pass its of" });

// The page reads only what it renders; compileTimeline (TP-2990) owns the rest of timeline.json.
// reveals, emphases, chips, hints, headline and chapter feed a stage beat's chrome and entrances; a page beat ignores them.
const TimelineBeatSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    startS: z.number().min(0),
    durationS: z.number().positive(),
    cues: z.record(z.string(), z.number().min(0)).optional(),
    slots: z.unknown(),
    reveals: z.array(RevealSchema).optional(),
    emphases: z.array(EmphasisSchema).optional(),
    chips: z.array(z.object({ kind: z.string().min(1), text: z.string().min(1) })).optional(),
    hints: HintsSchema.optional(),
    headline: z.string().min(1).optional(),
    chapter: ChapterSchema.optional(),
    /** A custom layer draws this beat from `module`, an ESM URL relative to the page, instead of its kind's view. */
    layer: z.literal("custom").optional(),
    module: z.string().min(1).optional(),
    /** The anchor cells the custom layer declares it occupies, for the occupancy table. */
    anchors: z.array(z.string().regex(ANCHOR_SPEC_PATTERN)).optional(),
  })
  .refine((b) => (b.reveals ?? []).every((r) => r.atS <= b.durationS + 1e-9), {
    message: "every reveal must land within its beat's durationS",
  })
  .refine((b) => (b.emphases ?? []).every((e) => e.atS <= b.durationS + 1e-9), {
    message: "every emphasis must land within its beat's durationS",
  })
  .refine((b) => (b.layer === "custom") === (b.module !== undefined), { message: "a custom-layer beat names its module, and only such a beat does" });

const TimelineSchema = z
  .object({
    durationS: z.number().positive(),
    /** Set when timings are planned rather than spoken; the page stamps such a render DRAFT. */
    provisional: z.boolean().optional(),
    beats: z.array(TimelineBeatSchema).min(1),
  })
  .refine((t) => t.beats.every((b) => b.startS + b.durationS <= t.durationS + 1e-9), {
    message: "every beat must end within the timeline's durationS",
  });

export type Timeline = z.infer<typeof TimelineSchema>;
export type TimelineBeat = Timeline["beats"][number];

export function parseTimeline(json: unknown): Timeline {
  return TimelineSchema.parse(json);
}

/** The `?timeline=` URL of a page location, resolved against it; absent means the page has nothing to render. */
export function timelineUrl(href: string): string {
  const url = new URL(href);
  const param = url.searchParams.get("timeline");
  if (!param) throw new Error("the composition page needs ?timeline=<url of timeline.json>");
  return new URL(param, url).href;
}

export async function fetchTimeline(url: string): Promise<Timeline> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`timeline ${url}: HTTP ${response.status}`);
  return parseTimeline(await response.json());
}
