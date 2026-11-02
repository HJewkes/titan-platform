import { isPoolUnavailable } from "@titan-design/github";
import type { FactEntry } from "../../registry/entry.js";
import { factRule, type PinClass } from "../../registry/pin-classes.js";
import { outputDigest, projectionDigest } from "../projection.js";
import type { Verdict } from "../validity.js";

export type CompareClass = "hit" | "false-hit" | "miss" | "miss-same-output" | "unmarked";

export interface CompareRow {
  family: PinClass;
  class: CompareClass;
  /** The verdict was `valid`. */
  materialValid: boolean;
  /** The verdict was `valid` with no input drifting; a false-hit that is material-only names an under-declared input (R23). */
  fullValid: boolean;
  drift: string[];
  liveProjection: string;
}

export interface CompareCall {
  verdict: Verdict | undefined;
  wouldFastForward: boolean;
  /** The projection digest of the marker the verdict found, or null when it found none. */
  markerProjection: string | null;
  /** The projection digest of the newest marker at the previous pin, or null when there is none. */
  previousProjection?: string | null;
  liveOutput: unknown;
  entry: FactEntry;
  memoHit: boolean;
}

/**
 * Compares what the marker runner would have done with what the live call did. A memo hit replays the blob's own record
 * and an `Unavailable` answer is no fact, so neither is a decision to compare.
 */
export function compareCall(call: CompareCall): CompareRow | undefined {
  const rule = factRule(call.entry.fact);
  if (call.memoHit || !rule || isPoolUnavailable(call.liveOutput)) return undefined;
  const liveProjection = projectionDigest(call.entry, call.liveOutput);
  const valid = call.verdict?.status === "valid";
  return {
    family: rule.pinClass,
    class: classify(call, liveProjection),
    materialValid: valid,
    fullValid: call.verdict?.status === "valid" && call.verdict.drift.length === 0,
    drift: call.verdict?.status === "valid" ? call.verdict.drift : [],
    liveProjection,
  };
}

function classify(call: CompareCall, liveProjection: string): CompareClass {
  if (!call.verdict) return "unmarked";
  if (call.wouldFastForward) return call.markerProjection === liveProjection ? "hit" : "false-hit";
  return call.previousProjection === liveProjection ? "miss-same-output" : "miss";
}
