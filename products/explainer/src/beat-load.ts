import { BeatSpecSchema, type BeatSpec } from "./beat-schema.js";
import { BEAT_SLOTS, isSlotRef } from "./beat-slots.js";
import { DEFAULT_DOCTRINE_DIR } from "./doctrine-load.js";
import { readYamlDir } from "./profile-load.js";

/** Reads every `beats/<type>.yaml` under `dir`: the beat-spec registry. A shape error throws naming the file. */
export function loadBeatSpecs(dir: string = DEFAULT_DOCTRINE_DIR): Map<string, BeatSpec> {
  return readYamlDir(dir, "beats", BeatSpecSchema, (spec) => spec.type);
}

export class UnknownBeatError extends Error {
  constructor(type: string, known: string[]) {
    super(`unknown beat ${type}; known: ${known.join(", ")}`);
    this.name = "UnknownBeatError";
  }
}

export class BeatSlotError extends Error {
  constructor(type: string, problems: string[]) {
    super(`beat ${type}: ${problems.join("; ")}`);
    this.name = "BeatSlotError";
  }
}

/** The spec for beat `type`; an unknown beat throws, listing the known ones, rather than building unspecified. */
export function beatSpecFor(specs: ReadonlyMap<string, BeatSpec>, type: string): BeatSpec {
  const spec = specs.get(type);
  if (spec) return spec;
  throw new UnknownBeatError(type, [...specs.keys()]);
}

/** The ids of a validated target list; the slot schema guarantees each element carries one. */
const idsOf = (list: unknown): string[] =>
  Array.isArray(list) ? list.flatMap((element: unknown) => (typeof element === "object" && element !== null && "id" in element && typeof element.id === "string" ? [element.id] : [])) : [];

function duplicateTargets(spec: BeatSpec, slots: Record<string, unknown>): string[] {
  return (spec.emphasis?.targets ?? []).flatMap((field) => {
    const ids = idsOf(slots[field]);
    return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].map((id) => `${field} repeats element id ${id}`);
  });
}

/**
 * One beat's slots, validated against its spec's schema. An unknown beat, a slot the schema
 * rejects, or an emphasis element id used twice (a cue must resolve to exactly one element) throws.
 */
export function parseBeatSlots(specs: ReadonlyMap<string, BeatSpec>, type: string, raw: unknown): Record<string, unknown> {
  const spec = beatSpecFor(specs, type);
  if (!isSlotRef(spec.slots)) throw new BeatSlotError(type, [`slots ${spec.slots} is not a schema in BEAT_SLOTS`]);
  const result = BEAT_SLOTS[spec.slots].safeParse(raw);
  if (!result.success) throw new BeatSlotError(type, result.error.issues.map((found) => `${found.path.join(".") || "(root)"} ${found.message}`));
  const duplicates = duplicateTargets(spec, result.data);
  if (duplicates.length > 0) throw new BeatSlotError(type, duplicates);
  return result.data;
}

/** The element ids an emphasis cue may target in one beat's validated slots. */
export function emphasisTargets(spec: BeatSpec, slots: Record<string, unknown>): string[] {
  return (spec.emphasis?.targets ?? []).flatMap((field) => idsOf(slots[field]));
}

/**
 * The element a script cue's `target` names in one beat's validated slots. Two target lists may
 * share an id, so a target naming no element, or more than one, throws.
 */
export function cueElement(spec: BeatSpec, slots: Record<string, unknown>, target: string): string {
  const found = emphasisTargets(spec, slots).filter((id) => id === target).length;
  if (found !== 1) throw new BeatSlotError(spec.type, [`cue target ${target} resolves to ${found} elements, not one`]);
  return target;
}
