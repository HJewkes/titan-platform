import type { LineSource } from "@titan-design/evidence";
import type { z } from "zod";
import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { BeatSlotError, emphasisTargets, parseBeatSlots } from "../beat-load.js";
import type { BeatSpec } from "../beat-schema.js";
import { isSlotRef, type BeatSlotRef } from "../beat-slots.js";
import type { ResolvedSchema } from "../resolve-stage.js";
import type { ScriptBeat, ScriptV1 } from "../script-schema.js";
import { withSlotOverrides } from "../slot-overrides.js";
import { DERIVERS } from "./derivers.js";
import { cueEmphases, type DrawnElements } from "./emphases.js";
import { deriveContinuation, deriveList, stageOf } from "./derive-rows.js";
import { lateFirstCue } from "./label-parse.js";
import { beatScope } from "./scope.js";
import { isDerived, type BeatScope, type Derivation, type Derived, type Emphasis, type FillHints, type Lead, type Reveal, type Underived } from "./types.js";

export type ResolvedRow = z.infer<typeof ResolvedSchema>["beats"][number];
type Resolved = Pick<z.infer<typeof ResolvedSchema>, "beats">;

export interface FillContext {
  /** The beat-spec registry (`loadBeatSpecs()` by the caller), so the fill reads no disk. */
  specs: ReadonlyMap<string, BeatSpec>;
  /** A pinned `slots` artifact by beat id: an entry replaces the derived layer. */
  pinned?: Readonly<Record<string, unknown>>;
  /** The run's cited code (`codeSource(code)`); without it code beats fall back. */
  code?: LineSource;
}

/** One template beat's storyboard slot props, parsed by its spec's slot schema, with what the page draws beside them. */
export interface FilledBeat {
  id: string;
  spec: string;
  ref: BeatSlotRef;
  component?: string;
  slots: Record<string, unknown>;
  /** The derived (or pinned) layer under resolver slots, before the owner's `visual.slots`. */
  generated: Record<string, unknown>;
  overridden: string[];
  reveals: Reveal[];
  /** Later cues on elements already drawn (a revealed row, an edge, the claim), each lighting its element. */
  emphases: Emphasis[];
  chips: { kind: string; text: string }[];
  hints: FillHints;
  tune?: Record<string, number | string | boolean>;
  fallback?: { from: string; reason: string };
}

export interface FilledScript {
  beats: FilledBeat[];
  /** Beats on a custom layer, which TP-2607 builds; the fill leaves them alone. */
  custom: string[];
}

export interface FillRefusal {
  beat: string;
  detail: string;
}

/** Whether resolve chose a custom layer for this row: such a beat is built by TP-2607 and never template-filled. */
export const isCustomRow = (row: ResolvedRow | undefined): boolean => row?.layer === "custom";

/** Thrown when any beat is refused; it lists every refusal, so one run reports them all. */
export class FillError extends Error {
  constructor(readonly refusals: readonly FillRefusal[]) {
    super(`template fill refused ${refusals.length} beat${refusals.length === 1 ? "" : "s"}: ${refusals.map((r) => `${r.beat} (${r.detail})`).join("; ")}`);
    this.name = "FillError";
  }
}

const LIST = "list";
const NOTHING: Derived = { slots: {}, reveals: [] };

function drawnSpec(specs: ReadonlyMap<string, BeatSpec>, type: string): { spec: BeatSpec; ref: BeatSlotRef } | string {
  const spec = specs.get(type);
  if (spec === undefined) return `beat spec ${type} is not in the registry`;
  return isSlotRef(spec.slots) ? { spec, ref: spec.slots } : `beat spec ${type} names slots ${spec.slots}, which is not a schema in BEAT_SLOTS`;
}

function tryParse(specs: ReadonlyMap<string, BeatSpec>, type: string, raw: unknown): { slots: Record<string, unknown> } | { problems: string } {
  try {
    return { slots: parseBeatSlots(specs, type, raw) };
  } catch (error) {
    if (error instanceof BeatSlotError) return { problems: error.message };
    throw error;
  }
}

/** The deriver's own reading of the beat's script fields, extending its chapter's stage when it continues it; never the pin. */
function ownDerivation(beat: ScriptBeat, row: ResolvedRow, ref: BeatSlotRef, scope: BeatScope): Derivation {
  const own = DERIVERS[ref](beat, scope);
  return scope.lead?.spec === row.beat ? deriveContinuation(beat, scope, scope.lead, own) : own;
}

/**
 * The layer the beat's spec is tried with: its own derivation, or the pinned entry in its place. A pin replaces slots
 * only: the script's cues still time the beat, so the derived reveals stay, and `keptReveals` drops those whose target
 * the pinned slots no longer hold.
 */
function triedLayer(beat: ScriptBeat, own: Derivation, pinned: unknown): Derivation {
  if (pinned === undefined) return own;
  if (!isRecord(pinned)) return { reason: `the slots pin's entry for ${beat.id} is not an object` };
  return { slots: pinned, reveals: isDerived(own) ? own.reveals : [] };
}

interface Attempt {
  own: Derivation;
  tried: Derivation;
  problems: string;
  pinned: unknown;
}

/**
 * The kind a beat draws when its spec's slots do not parse, and why: the fallback its own derivation names, else a
 * list. The derivation decides, pinned or not, so render draws a beat from resolve's `generated-slots` pin as the
 * same kind resolve drew; the pin's slots, which are that kind's, fill it.
 */
function fallbackFor(beat: ScriptBeat, scope: BeatScope, { own, tried, problems, pinned }: Attempt): Underived {
  const to = (isDerived(own) ? undefined : own.fallback) ?? { spec: LIST, derived: deriveList(beat, scope) };
  const reason = !isDerived(own) ? own.reason : isDerived(tried) ? problems : tried.reason;
  const derived = isRecord(pinned) ? { slots: pinned, reveals: to.derived.reveals } : to.derived;
  return { reason, fallback: { spec: to.spec, derived } };
}

/** The element ids the final slots hold, with the map edges among them. */
function drawnElements(spec: BeatSpec, slots: Record<string, unknown>): DrawnElements {
  const edges = Array.isArray(slots["edges"]) ? (slots["edges"] as DrawnElements["edges"]) : [];
  return { present: new Set([...emphasisTargets(spec, slots), ...Object.keys(slots)]), edges };
}

/** Reveals of elements the final slots still hold: an override that replaces a list drops the derived items' cues. */
const keptReveals = (drawn: DrawnElements, reveals: readonly Reveal[]): Reveal[] => reveals.filter((reveal) => drawn.present.has(reveal.target));

interface Layers {
  generated: Record<string, unknown>;
  slots: Record<string, unknown>;
}

function filled(beat: ScriptBeat, drawn: { spec: BeatSpec; ref: BeatSlotRef }, layers: Layers, derived: Derived, fallback?: FilledBeat["fallback"]): FilledBeat {
  const elements = drawnElements(drawn.spec, layers.slots);
  const reveals = keptReveals(elements, derived.reveals);
  const late = derived.hints?.continues === undefined && lateFirstCue(beat, reveals);
  const { name } = drawn.spec.component;
  return {
    id: beat.id,
    spec: drawn.spec.type,
    ref: drawn.ref,
    ...(name === undefined ? {} : { component: name }),
    ...layers,
    overridden: Object.keys(beat.visual.slots ?? {}),
    reveals,
    emphases: cueEmphases(beat, elements, reveals),
    chips: beat.visual.chips.map(({ kind, text }) => ({ kind, text })),
    hints: { ...derived.hints, ...(late ? { placeholder: true as const } : {}) },
    ...(beat.visual.tune === undefined ? {} : { tune: { ...beat.visual.tune } }),
    ...(fallback === undefined ? {} : { fallback }),
  };
}

/** The fallback `fallbackFor` chose, drawn only when its own slots parse. */
function fallBack(beat: ScriptBeat, row: ResolvedRow, scope: BeatScope, specs: ReadonlyMap<string, BeatSpec>, why: Underived): FilledBeat | FillRefusal {
  const to = why.fallback ?? { spec: LIST, derived: deriveList(beat, scope) };
  const drawn = drawnSpec(specs, to.spec);
  if (typeof drawn === "string") return { beat: beat.id, detail: `${row.beat}: ${why.reason}; ${drawn}` };
  const parsed = tryParse(specs, to.spec, to.derived.slots);
  if (!("slots" in parsed)) return { beat: beat.id, detail: `${row.beat}: ${why.reason}; the ${to.spec} fallback is invalid too: ${parsed.problems}` };
  return filled(beat, drawn, { generated: to.derived.slots, slots: parsed.slots }, to.derived, { from: row.beat, reason: why.reason });
}

/**
 * One template beat's slots: the derived layer (or the pinned entry), then resolver slots, then the owner's
 * `visual.slots`, parsed by the spec's schema. Slots that do not parse fall back to a list, unless the owner set
 * `visual.slots`: then the owner meant this spec, and the beat is refused naming the fields.
 */
export function fillBeat(beat: ScriptBeat, row: ResolvedRow, scope: BeatScope, context: FillContext): FilledBeat | FillRefusal {
  const drawn = drawnSpec(context.specs, row.beat);
  if (typeof drawn === "string") return { beat: beat.id, detail: drawn };
  const own = ownDerivation(beat, row, drawn.ref, scope);
  const pinned = context.pinned?.[beat.id];
  const derived = triedLayer(beat, own, pinned);
  const generated = { ...(isDerived(derived) ? derived.slots : {}), ...row.slots };
  const parsed = tryParse(context.specs, row.beat, withSlotOverrides(beat.visual, generated));
  if ("slots" in parsed) return filled(beat, drawn, { generated, slots: parsed.slots }, isDerived(derived) ? derived : NOTHING);
  if (beat.visual.slots !== undefined) return { beat: beat.id, detail: `visual.slots leave ${row.beat} invalid: ${parsed.problems}` };
  return fallBack(beat, row, scope, context.specs, fallbackFor(beat, scope, { own, tried: derived, problems: parsed.problems, pinned }));
}

const isRefusal = (found: FilledBeat | FillRefusal): found is FillRefusal => "detail" in found;

/** One beat on its chapter's stage; a filled beat that did not fall back opens or extends that stage. */
function fillInOrder(script: ScriptV1, beat: ScriptBeat, row: ResolvedRow | undefined, leads: Map<string, Lead>, context: FillContext): FilledBeat | FillRefusal {
  if (row === undefined) return { beat: beat.id, detail: "the resolved artifact has no row for this beat" };
  const lead = leads.get(beat.chapter);
  const found = fillBeat(beat, row, beatScope(script, beat, context.code, lead), context);
  const stage = isRefusal(found) || found.fallback !== undefined ? undefined : stageOf(found.id, found.spec, found.slots, lead);
  if (stage !== undefined) leads.set(beat.chapter, stage);
  return found;
}

/**
 * Every template beat of the script filled in order, so a chapter's later beats can extend its lead's stage. Custom
 * beats are listed, not filled. Any refused beat throws a FillError listing them all.
 */
export function fillScript(script: ScriptV1, resolved: Resolved, context: FillContext): FilledScript {
  const rows = new Map(resolved.beats.map((row) => [row.id, row]));
  const leads = new Map<string, Lead>();
  const out: FilledScript = { beats: [], custom: [] };
  const refused: FillRefusal[] = [];
  for (const beat of script.beats) {
    const row = rows.get(beat.id);
    if (isCustomRow(row)) {
      out.custom.push(beat.id);
      continue;
    }
    const found = fillInOrder(script, beat, row, leads, context);
    if (isRefusal(found)) refused.push(found);
    else out.beats.push(found);
  }
  if (refused.length > 0) throw new FillError(refused);
  return out;
}
