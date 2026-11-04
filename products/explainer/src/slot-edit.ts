import { z } from "zod";
import { withSlotOverrides } from "./slot-overrides.js";
import { ScriptSchema, type ScriptBeat } from "./script-schema.js";

const Sha = z.string().regex(/^[0-9a-f]{64}$/, "expected a full sha256");
const TuneValue = z.union([z.number(), z.string(), z.boolean()]);

/**
 * One owner save (`explainer.slot-edit/v1`): slot and tune fields per template beat, over the run it was drafted on.
 * A field's value replaces the field whole; `null` drops the override so the generated value stands again. Nothing
 * else of a beat is editable here (Q-V3): spoken and framing changes go through rewrite and eval.
 */
export const SlotEditSchema = z
  .object({
    schema: z.literal("explainer.slot-edit/v1"),
    base: z.object({ runId: z.string().min(1), scriptSha: Sha, mp4Sha: Sha }).strict(),
    beats: z.record(
      z.string().min(1),
      z.object({ slots: z.record(z.string(), z.unknown()).optional(), tune: z.record(z.string(), TuneValue.nullable()).optional() }).strict(),
    ),
    fromNote: z.string().min(1).optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type SlotEdit = z.infer<typeof SlotEditSchema>;

/** One edited field: its path under the beat and the value the render saw before (generated or overridden) and after. */
export interface FieldChange {
  beat: string;
  path: string;
  before: unknown;
  after: unknown;
}

export type EditResult = { ok: true; script: Record<string, unknown>; diff: FieldChange[] } | { ok: false; problems: string[] };

/** The run the edit names, as the store holds it: its script's sha and raw JSON, and each beat's resolved layer. */
export interface EditBase {
  runId: string;
  scriptSha: string;
  script: unknown;
  layers: ReadonlyMap<string, string>;
  /** The generated slots by beat id (the template fill's), so a field's before value is known; absent, overrides only. */
  generated?: Readonly<Record<string, unknown>>;
}

type Fields = Record<string, unknown>;
type Cue = ScriptBeat["visual"]["cues"][number];

const isFields = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value);
const short = (sha: string): string => sha.slice(0, 12);

const elementIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((item) => (isFields(item) && typeof item.id === "string" ? [item.id] : [])) : [];

function staleBase(base: EditBase, edit: SlotEdit): string[] {
  if (edit.base.runId !== base.runId) return [`base: the edit is over run ${edit.base.runId}, not ${base.runId}`];
  if (edit.base.scriptSha !== base.scriptSha) {
    return [`base: the edit was drafted on script ${short(edit.base.scriptSha)}, but run ${base.runId}'s script is ${short(base.scriptSha)}; reopen the beat and draft again`];
  }
  return [];
}

/** Every cue the new value of `field` strands: its target was an element of the field before and is not after. */
function strandedCues(id: string, field: string, cues: readonly Cue[], before: unknown, after: unknown): string[] {
  const had = new Set(elementIds(before));
  const has = new Set(elementIds(after));
  return cues.flatMap((cue, i) => (had.has(cue.target) && !has.has(cue.target)
    ? [`beats.${id}.visual.slots.${field}: drops element ${cue.target}, which cue ${i} (${cue.action} at "${cue.atCue}") targets; keep its id or retarget the cue`]
    : []));
}

/** Lays `changes` over `current`: a `null` drops the field; an empty result is no field at all. */
function overlay(current: Fields | undefined, changes: Fields | undefined): Fields | undefined {
  if (changes === undefined) return current;
  const next: Fields = { ...current };
  for (const [field, value] of Object.entries(changes)) {
    if (value === null) delete next[field];
    else next[field] = value;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

interface BeatEdit {
  id: string;
  visual: ScriptBeat["visual"];
  change: SlotEdit["beats"][string];
  generated: unknown;
}

function beatChanges({ id, visual, change, generated }: BeatEdit): { diff: FieldChange[]; problems: string[] } {
  const before = withSlotOverrides(visual, generated);
  const after = withSlotOverrides({ slots: overlay(visual.slots, change.slots) }, generated);
  const fields = (value: unknown): Fields => (isFields(value) ? value : {});
  const slotDiff = Object.keys(change.slots ?? {}).map((field) => ({ beat: id, path: `visual.slots.${field}`, before: fields(before)[field], after: fields(after)[field] }));
  const nextTune = overlay(visual.tune, change.tune) ?? {};
  const tuneDiff = Object.keys(change.tune ?? {}).map((field) => ({ beat: id, path: `visual.tune.${field}`, before: visual.tune?.[field], after: nextTune[field] }));
  const problems = slotDiff.flatMap((d) => strandedCues(id, d.path.slice("visual.slots.".length), visual.cues, d.before, d.after));
  const changed = [...slotDiff, ...tuneDiff].filter((d) => JSON.stringify(d.before) !== JSON.stringify(d.after));
  return { diff: changed, problems };
}

function scopeProblems(id: string, beat: ScriptBeat | undefined, layer: string | undefined): string[] {
  if (beat === undefined) return [`beats.${id}: the base script has no beat ${id}`];
  if (layer !== "template") return [`beats.${id}: its layer is ${layer ?? "unresolved"}; v1 edits change slots and tune on template beats only`];
  return [];
}

/** Writes the edited fields into the raw script, so every byte the edit does not name stays as the base had it. */
function writeBack(script: Fields, edit: SlotEdit): Fields {
  const next = structuredClone(script);
  const beats: unknown[] = Array.isArray(next.beats) ? next.beats : [];
  for (const beat of beats) {
    const visual = isFields(beat) ? beat.visual : undefined;
    const change = isFields(beat) && typeof beat.id === "string" ? edit.beats[beat.id] : undefined;
    if (change === undefined || !isFields(visual)) continue;
    for (const key of ["slots", "tune"] as const) {
      const current = visual[key];
      const value = overlay(isFields(current) ? current : undefined, change[key]);
      if (value === undefined) delete visual[key];
      else visual[key] = value;
    }
  }
  return next;
}

/**
 * Applies an owner edit to its base run's script. Refuses a stale base, a beat the script lacks, a beat whose layer is
 * not `template`, and a slot change that drops an element a cue targets (naming the cue); otherwise returns the new
 * script, identical to the base outside each edited beat's `visual.slots` and `visual.tune`, and the field diff.
 */
export function applyEdit(base: EditBase, edit: SlotEdit): EditResult {
  const stale = staleBase(base, edit);
  if (stale.length > 0) return { ok: false, problems: stale };
  const parsed = ScriptSchema.safeParse(base.script);
  if (!parsed.success || !isFields(base.script)) return { ok: false, problems: [`base: run ${base.runId}'s script does not parse as script/v1`] };
  const beats = new Map(parsed.data.beats.map((beat) => [beat.id, beat]));
  const results = Object.entries(edit.beats).map(([id, change]) => {
    const scope = scopeProblems(id, beats.get(id), base.layers.get(id));
    if (scope.length > 0) return { diff: [], problems: scope };
    return beatChanges({ id, visual: beats.get(id)!.visual, change, generated: base.generated?.[id] });
  });
  const problems = results.flatMap((r) => r.problems);
  const diff = results.flatMap((r) => r.diff);
  if (problems.length === 0 && diff.length === 0) problems.push("beats: the edit changes nothing");
  return problems.length > 0 ? { ok: false, problems } : { ok: true, script: writeBack(base.script, edit), diff };
}
