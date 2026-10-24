import { z } from "zod";

// The page reads only what it renders; compileTimeline (TP-2990) owns the rest of timeline.json.
const TimelineBeatSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  startS: z.number().min(0),
  durationS: z.number().positive(),
  cues: z.record(z.string(), z.number().min(0)).optional(),
  slots: z.unknown(),
});

export const TimelineSchema = z
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
