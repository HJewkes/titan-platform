import { z } from "zod";

// A cue is a spoken word ("word" or "word#n" for its nth use in the beat), resolved to seconds
// from the beat's word timings. Hand-timed seconds never appear in a beat's visual track.
const Cue = z.string().regex(/^[^\s#]+(?:#[1-9]\d*)?$/, "expected word or word#n");
const Id = z.string().min(1);

export const MAP_LEVELS = ["context", "containers", "components", "code"] as const;
export const EDGE_SOURCES = ["import", "call", "protocol", "traced"] as const;

const CameraSchema = z.union([
  z.object({ fit: z.array(Id).min(1), atCue: Cue }).strict(),
  z.object({ station: Id, atCue: Cue }).strict(),
]);

const atCue = <T extends z.ZodRawShape>(shape: T) => z.object({ ...shape, atCue: Cue }).strict();

/** One beat's full target state for the repo map. Fields left out resume the map's last state. */
export const MapStateSchema = z
  .object({
    level: z.enum(MAP_LEVELS),
    camera: CameraSchema.optional(),
    reveal: z.array(atCue({ id: Id })).optional(),
    edges: z.array(atCue({ id: Id })).optional(),
    visible: z.union([z.array(Id), z.literal("level")]).optional(),
    active: z.array(Id).optional(),
    focus: atCue({ ids: z.array(Id) }).optional(),
    message_in_flight: atCue({
      flow: Id,
      fromHop: z.number().int().nonnegative(),
      toHop: z.number().int().nonnegative(),
      speed: z.union([z.literal(1), z.literal(3)]).optional(),
    }).optional(),
    cards: z.array(atCue({ ref: Id, untilCue: Cue.nullable() })).optional(),
    annotations: z
      .array(atCue({ kind: z.enum(["circle", "box", "underline", "arrow", "marker"]), anchor: Id }))
      .optional(),
    pins: z.array(atCue({ anchor: Id, text: z.string().min(1) })).optional(),
    minimap: z.boolean().optional(),
  })
  .strict();

/** A beat's visual track. `map_state` absent means the map is off screen for this beat. */
export const VisualSchema = z
  .object({
    job: z.enum(["map", "cast-in-motion", "alternatives-vs-ours", "artifact-filling", "zoom", "code-proof", "numbers"]),
    layout_source: z.enum(["code-graph", "hand"]),
    edge_sources: z.array(z.enum(EDGE_SOURCES)).default([]),
    fact_ids: z.array(Id).default([]),
    chips: z.array(Id).default([]),
    map_state: MapStateSchema.optional(),
  })
  .strict();

/** The fields of a beats.json beat that the map timeline reads; other beat fields pass through. */
export const MapBeatSchema = z.object({
  id: Id,
  duration_s: z.number().positive(),
  visual: VisualSchema.optional(),
});

/** The repo map's ids, as the layout emits them; an edge carries the evidence that drew it. */
export const MapLayoutSchema = z.object({
  nodes: z.array(z.object({ id: Id })),
  edges: z.array(z.object({ id: Id, edgeSource: z.enum(EDGE_SOURCES).optional() })),
});

export type MapLevel = (typeof MAP_LEVELS)[number];
export type MapState = z.infer<typeof MapStateSchema>;
export type Visual = z.infer<typeof VisualSchema>;
export type MapBeat = z.infer<typeof MapBeatSchema>;
export type MapLayout = z.infer<typeof MapLayoutSchema>;
