import { readFileSync } from "node:fs";
import type { ScriptBeat, ScriptV1 } from "./script-schema.js";
import { tour, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

// Synthetic: an invented parcel desk; nothing here quotes a real repo or video.
export const resolveFixture = (name: string): string => readFileSync(new URL(`../fixtures/resolve/${name}`, import.meta.url), "utf8");

/** A visual track on the positive control's assertion, with the fields a test sets. */
export const visual = (patch: Record<string, unknown> = {}) => ({ assertion: "The desk refuses unknown parcels", job: "numbers", ...patch });

const SPOKEN = "The desk server holds each scan until the ledger confirms the parcel.";

/** A one-or-more-beat script; each entry is `[id, function, extra fields]`, spoken over ten seconds in chapter ch1. */
export function resolveScript(beats: [id: string, fn: string, extra?: Record<string, unknown>][]): ScriptV1 {
  const specs: BeatSpec[] = beats.map(([id, fn, extra = {}]) => [id, "ch1", fn, SPOKEN, extra]);
  return tour(specs, { thesis_refs: undefined });
}

/** One parsed beat with `extra` laid over the defaults. */
export const oneBeat = (fn = "WHAT", extra: Record<string, unknown> = {}): ScriptBeat => resolveScript([["b1", fn, extra]]).beats[0]!;

/** `count` words of filler speech. */
export const wordsLong = (count: number): string => Array.from({ length: count }, (_, i) => (i === 0 ? "Parcels" : "parcels")).join(" ");
