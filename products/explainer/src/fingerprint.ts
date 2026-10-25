import { expandAnchors } from "./anchor-grid.js";
import { canonicalJson } from "./eval-store.js";
import type { ResolvedSchema } from "./resolve-stage.js";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";
import { sha256 } from "./workflow/artifacts.js";
import type { z } from "zod";

/**
 * A video's variety fingerprint (TP-4019): what the series lints compare against the previous videos of its series.
 * The script side only; `pixel` stays null until the beat-aware sheets give each custom beat a settled frame.
 */
export const FINGERPRINT_SCHEMA = "explainer.fingerprint/v1";

type ResolvedBeat = z.infer<typeof ResolvedSchema>["beats"][number];

export interface BeatPrint {
  id: string;
  /** `${component}/${slots}/${anchors}`: the look-alike and seen-before key of a template beat. */
  layoutKey: string;
  layer: string;
  framing: string | null;
  pixel: string | null;
}

export interface Fingerprint {
  schema: typeof FINGERPRINT_SCHEMA;
  profile: string;
  structure: string | null;
  hookKind: string | null;
  opening: string;
  closing: string;
  chapterLabels: string[];
  componentHistogram: Record<string, number>;
  framingSequence: (string | null)[];
  functionMix: Record<string, number>;
  closeKind: string;
  signatureLayer: string | null;
  /** Sorted 32-bit hashes of the spoken 4-grams with numbers and lexicon terms masked. */
  stockGrams: number[];
  skeleton: { chapterLabels: string[]; beatStems: string[]; functions: string[] };
  beats: BeatPrint[];
}

export interface FingerprintInput {
  script: ScriptV1;
  /** The `resolved` artifact; a legacy bridged run has none and the key falls back to the script's visual. */
  resolved?: { beats: readonly ResolvedBeat[] };
  /** The template fill's `slots` artifact: beat id to its slot values. */
  slots?: Readonly<Record<string, unknown>>;
  /** Structure id to the hook its registry entry names. */
  hooks: ReadonlyMap<string, string>;
  /** Terms masked out of the stock grams, so a repo's own names never make two videos look alike. */
  terms?: readonly string[];
}

export interface LayoutParts {
  component: string;
  slots: number;
  anchors: readonly string[];
}

export const layoutKey = ({ component, slots, anchors }: LayoutParts): string => `${component}/${slots}/${anchors.join("+") || "-"}`;

function component(beat: ScriptBeat, resolved: ResolvedBeat | undefined): string {
  if (resolved) return resolved.component.name ?? `spec:${resolved.beat}`;
  return beat.visual.render ?? `job:${beat.visual.job}`;
}

function slotCount(beat: ScriptBeat, slots: FingerprintInput["slots"]): number {
  const filled = slots?.[beat.id];
  return filled !== null && typeof filled === "object" ? Object.keys(filled).length : beat.visual.labels.length;
}

/** The resolver's anchors win: it fills a framing's default where the script named none. */
const anchorsOf = (beat: ScriptBeat, resolved: ResolvedBeat | undefined): string[] => expandAnchors(resolved?.anchors ?? beat.visual.anchors ?? []);

export function beatPrint(beat: ScriptBeat, resolved: ResolvedBeat | undefined, slots: FingerprintInput["slots"]): BeatPrint & { component: string } {
  const parts = { component: component(beat, resolved), slots: slotCount(beat, slots), anchors: anchorsOf(beat, resolved) };
  const layer = resolved?.layer ?? beat.visual.layer ?? "template";
  return { id: beat.id, component: parts.component, layoutKey: layoutKey(parts), layer, framing: resolved?.framing ?? beat.visual.framing ?? null, pixel: null };
}

const histogram = (values: readonly string[]): Record<string, number> =>
  values.reduce<Record<string, number>>((acc, value) => ({ ...acc, [value]: (acc[value] ?? 0) + 1 }), {});

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(text)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
}

const STOCK_GRAM = 4;

/** Slot-masked 4-grams: numbers become `#` and each known term `@`, so only the stock wording around them is left. */
export function stockGrams(spoken: readonly string[], terms: readonly string[] = []): number[] {
  const masked = terms.map((term) => term.toLowerCase()).filter(Boolean).sort((a, b) => b.length - a.length);
  const grams = new Set<number>();
  for (const line of spoken) {
    let text = line.toLowerCase();
    for (const term of masked) text = text.split(term).join(" @ ");
    const words = text.split(/[^a-z0-9@'#]+/).filter(Boolean).map((word) => (/\d/.test(word) ? "#" : word));
    for (let i = 0; i + STOCK_GRAM <= words.length; i++) grams.add(fnv1a(words.slice(i, i + STOCK_GRAM).join(" ")));
  }
  return [...grams].sort((a, b) => a - b);
}

/** A split beat's continuations (`b03-2`) share their first part's stem. */
const beatStem = (id: string): string => id.replace(/-\d+$/, "");

export function fingerprintOf(input: FingerprintInput): Fingerprint {
  const { script } = input;
  const byId = new Map((input.resolved?.beats ?? []).map((beat) => [beat.id, beat]));
  const prints = script.beats.map((beat) => beatPrint(beat, byId.get(beat.id), input.slots));
  const functions = script.beats.map((beat) => byId.get(beat.id)?.key.function ?? beat.function);
  const chapterLabels = script.chapters.map((chapter) => chapter.label);
  return {
    schema: FINGERPRINT_SCHEMA, profile: script.profile, structure: script.structure ?? null,
    hookKind: script.structure ? (input.hooks.get(script.structure) ?? null) : null,
    opening: script.beats[0]!.id, closing: script.beats.at(-1)!.id, chapterLabels,
    componentHistogram: histogram(prints.map((print) => print.component)), framingSequence: prints.map((print) => print.framing),
    functionMix: histogram(functions), closeKind: script.video.close_type, signatureLayer: script.signature_layer?.kind ?? null,
    stockGrams: stockGrams(script.beats.map((beat) => beat.spoken), input.terms),
    skeleton: { chapterLabels, beatStems: [...new Set(script.beats.map((beat) => beatStem(beat.id)))], functions },
    beats: prints.map(({ component: _component, ...print }) => print),
  };
}

/** The sidecar's copy: the grams by hash only, so the console's 32 KB fingerprint cap holds for any script length. */
export function sidecarFingerprint({ stockGrams: grams, ...rest }: Fingerprint): Record<string, unknown> {
  return { ...rest, stockGramsSha: sha256(canonicalJson(grams)) };
}
