import type { z } from "zod";
import type { BeatSpec } from "./beat-schema.js";
import { BEAT_SLOTS, isSlotRef } from "./beat-slots.js";
import type { ScriptBeat } from "./script-schema.js";

type Visual = Pick<ScriptBeat["visual"], "slots">;

/**
 * A beat's slots with the owner's `visual.slots` laid over them: the overrides win over every generated layer, and each
 * field replaces the generated value whole. A beat with no overrides gets its generated slots back as they were.
 */
export function withSlotOverrides(visual: Visual, generated: unknown): unknown {
  if (visual.slots === undefined) return generated;
  const base = typeof generated === "object" && generated !== null && !Array.isArray(generated) ? generated : {};
  return { ...base, ...visual.slots };
}

/** What the gate needs of a resolved beat: the spec it chose and the layer that draws it. */
export interface ChosenBeat {
  id: string;
  beat: string;
  layer: string;
}

const where = (id: string, field?: string, path: readonly PropertyKey[] = []): string =>
  ["beats", id, "visual", ...(field === undefined ? [] : ["slots", field]), ...path.map(String)].join(".");

function fieldProblems(id: string, spec: BeatSpec, overrides: Record<string, unknown>): string[] {
  if (!isSlotRef(spec.slots)) return [`${where(id)}: beat spec ${spec.type} names slots ${spec.slots}, which is not a schema in BEAT_SLOTS`];
  const shape = BEAT_SLOTS[spec.slots].shape as Record<string, z.ZodType>;
  return Object.entries(overrides).flatMap(([field, value]) => {
    const slot = shape[field];
    if (slot === undefined) return [`${where(id, field)}: beat spec ${spec.type} has no slot ${field}`];
    const parsed = slot.safeParse(value);
    return parsed.success ? [] : parsed.error.issues.map((issue) => `${where(id, field, issue.path)}: ${issue.message}`);
  });
}

/**
 * Every owner override the chosen beat spec would not accept, each naming its path: overrides only on template beats,
 * and each `visual.slots` field one the spec's slot schema has and whose value parses. Whether the filled whole parses
 * is the template fill's check; this gate catches a bad override by any route that reaches resolve.
 */
export function slotOverrideProblems(beats: readonly Pick<ScriptBeat, "id" | "visual">[], chosen: readonly ChosenBeat[], specs: ReadonlyMap<string, BeatSpec>): string[] {
  const byId = new Map(chosen.map((beat) => [beat.id, beat]));
  return beats.flatMap(({ id, visual }) => {
    if (visual.slots === undefined && visual.tune === undefined) return [];
    const found = byId.get(id);
    if (found?.layer !== "template") return [`${where(id)}: slot and tune overrides apply only to template beats; this beat's layer is ${found?.layer ?? "unresolved"}`];
    const spec = specs.get(found.beat);
    if (spec === undefined) return [`${where(id)}: beat spec ${found.beat} is not in the registry`];
    return fieldProblems(id, spec, visual.slots ?? {});
  });
}
