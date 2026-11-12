// TP-5408 (gate model S5, owner decision D-B): `shepherd.visualGate` takes visual review off the merge gate. Under
// `async` a visual path is a recorded fact the post-merge feedback sheet reads, not a guard row, sign-off or tier.
import { z } from "zod";
import { shownPaths, visualMatches } from "./visual-gate.js";

/**
 * `shepherd.visualGate`, a live switch. `async` merges a visual PR on its reviews and green CI and records `visualChanged`;
 * `owner`, or absent, keeps the owner's merge gate.
 */
export const VisualGateSchema = z.enum(["owner", "async"]);

export type VisualGateMode = z.infer<typeof VisualGateSchema>;

/** Only an exact `async` leaves the merge gate; absent, or anything else, keeps the owner's gate. */
export function visualGateMode(value: unknown): VisualGateMode {
  return value === "async" ? "async" : "owner";
}

/** The evidence step stamps the mode it decided under, so a later `decide` at that head judges the same way. */
export const visualGateField = (value: unknown): { visualGate?: "async" } => (visualGateMode(value) === "async" ? { visualGate: "async" } : {});

/** The changed paths the run's visual globs match, recorded only under `async`, where nothing gates on them. */
export function visualChangedField(value: unknown, changedPaths: readonly string[], visualPaths: readonly string[] | undefined): { visualChanged?: string[] } {
  if (visualGateMode(value) !== "async" || visualPaths === undefined) return {};
  const changed = visualMatches(changedPaths, visualPaths);
  return changed.length > 0 ? { visualChanged: changed } : {};
}

/** Names the visual paths an `async` allow merged without the owner, so the evidence comment shows them. */
export function asyncVisualNote(value: unknown, changedPaths: readonly string[], visualPaths: readonly string[] | undefined): string {
  const changed = visualChangedField(value, changedPaths, visualPaths).visualChanged;
  return changed === undefined ? "" : `; visual changed ${shownPaths(changed)}, reviewed after merge (visualGate async)`;
}

const VISUAL_HOLD_CLASS = "visual-gate2";
const VISUAL_GATE_REASON = "gate-2-visual";

/**
 * Whether a hold class or registration gate reason still stands for the owner. Under `async` a `visual-gate2` hold or a
 * `gate-2-visual` registration does not: the plan-time visual sign-off flag (gate model S8) is to be its only source.
 */
export function keepsOwnerGate(value: unknown, classOrReason: string): boolean {
  return visualGateMode(value) === "owner" || (classOrReason !== VISUAL_HOLD_CLASS && classOrReason !== VISUAL_GATE_REASON);
}
