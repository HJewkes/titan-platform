import { z } from "zod";
import { buildPaceBeats, type PaceBeat, type PaceSourceBeat } from "./pace-items.js";
import type { ScriptTiming } from "./timing.js";

const Id = z.string().min(1);
const Reveal = z.object({ id: Id, atCue: z.string() });
const Pin = z.object({ anchor: Id, text: z.string().min(1), atCue: z.string() });
const MapSide = z.object({ reveal: z.array(Reveal).default([]), pins: z.array(Pin).default([]) });

// Only the fields the pace layer reads, and none of them `.strict()`: a Python-emitted spike script carries keys
// `ScriptSchema` rejects (beat `band`, visual `render`, top-level `maps`, map_state `old`/`new`, more than two
// invariants), and widening `ScriptSchema` to admit them would loosen every script/v1 check.
const SpikeScriptSchema = z.object({
  id: Id,
  maps: z.record(z.string(), z.object({ nodes: z.array(z.object({ id: Id, label: z.string().min(1) })) })).default({}),
  beats: z.array(
    z.object({
      id: Id,
      chapter: Id,
      function: Id,
      plannedS: z.number().positive(),
      spoken: z.string().min(1),
      origin: z.string().optional(),
      visual: z.object({
        render: z.string().optional(),
        titles: z.array(z.string().min(1)).default([]),
        cues: z.array(z.object({ target: Id, atCue: z.string().optional() })).default([]),
        map_state: MapSide.extend({ map: Id, old: MapSide.optional(), new: MapSide.optional() }).optional(),
      }),
    }),
  ),
});

export type SpikeScript = z.infer<typeof SpikeScriptSchema>;
type SpikeBeat = SpikeScript["beats"][number];

/** A spike script as read, plus every key path the reader skipped (`beats[].band`, `maps.*.nodeBox`). */
export interface SpikeRead {
  script: SpikeScript;
  ignored: string[];
}

function collectIgnored(schema: z.ZodType, value: unknown, path: string, out: Set<string>): void {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    collectIgnored(schema.unwrap() as z.ZodType, value, path, out);
  } else if (schema instanceof z.ZodArray && Array.isArray(value)) {
    for (const v of value) collectIgnored(schema.element as z.ZodType, v, `${path}[]`, out);
  } else if (schema instanceof z.ZodRecord && value && typeof value === "object") {
    for (const v of Object.values(value)) collectIgnored(schema.valueType as z.ZodType, v, `${path}.*`, out);
  } else if (schema instanceof z.ZodObject && value && typeof value === "object") {
    const shape = schema.shape as Record<string, z.ZodType>;
    for (const [key, v] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      if (Object.hasOwn(shape, key)) collectIgnored(shape[key] as z.ZodType, v, at, out);
      else out.add(at);
    }
  }
}

/** Reads a Python-emitted spike script.json loosely; `ScriptSchema` is never consulted or widened. */
export function readSpikeScript(json: unknown): SpikeRead {
  const script = SpikeScriptSchema.parse(json);
  const ignored = new Set<string>();
  collectIgnored(SpikeScriptSchema, json, "", ignored);
  return { script, ignored: [...ignored].sort() };
}

type Labeller = (map: string, id: string) => string;

function sideItems(side: z.infer<typeof MapSide>, map: string, label: Labeller) {
  return {
    reveals: side.reveal.map((r) => ({ id: r.id, label: label(map, r.id), atCue: r.atCue })),
    pins: side.pins.map((p) => ({ anchor: p.anchor, label: p.text, atCue: p.atCue })),
  };
}

function spikeSourceBeat(beat: SpikeBeat, label: Labeller): PaceSourceBeat {
  const { render, titles, cues, map_state: state } = beat.visual;
  const sides = state
    ? [sideItems(state, state.map, label), ...(["old", "new"] as const).flatMap((m) => (state[m] ? [sideItems(state[m], m, label)] : []))]
    : [];
  return {
    id: beat.id,
    chapter: beat.chapter,
    fn: beat.function,
    spoken: beat.spoken,
    plannedS: beat.plannedS,
    ...(beat.origin === undefined ? {} : { origin: beat.origin }),
    ...(render === undefined ? {} : { render }),
    mapBeside: state !== undefined,
    cues,
    titles,
    reveals: sides.flatMap((s) => s.reveals),
    pins: sides.flatMap((s) => s.pins),
    cards: [],
    terms: [],
  };
}

/** The item track of a spike script.json; map reveals are labelled from its `maps` node labels. */
export function fromSpikeScript(json: unknown, timing?: ScriptTiming): PaceBeat[] {
  const { script } = readSpikeScript(json);
  const labels = new Map(Object.entries(script.maps).flatMap(([map, { nodes }]) => nodes.map((n) => [`${map}:${n.id}`, n.label])));
  const label: Labeller = (map, id) => labels.get(`${map}:${id}`) ?? id;
  return buildPaceBeats(script.beats.map((b) => spikeSourceBeat(b, label)), timing);
}
