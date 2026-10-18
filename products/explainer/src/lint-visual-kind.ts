import type { L0Check, L0Result } from "./eval-l0.js";
import type { ScriptV1 } from "./script-schema.js";
import { findVisualType, shippedVisualRouter, type VisualRouter } from "./visual-router.js";

export const VISUAL_GAP_CHECK_ID = "visual:gap-kind";

/**
 * The beats whose `kind` names a visual-router type that nothing renders yet. A warning, never a
 * block (TP-3597 D7): it makes gaps visible and countable, and the packet already names the stand-in.
 */
export function visualGapBeats(script: ScriptV1, router: VisualRouter = shippedVisualRouter()): string[] {
  return script.beats.filter((beat) => beat.kind !== undefined && findVisualType(router, beat.kind)?.route.gap === true).map((beat) => beat.id);
}

function gapRow(beats: string[]): L0Result {
  return { check_id: VISUAL_GAP_CHECK_ID, mode: "tagged", severity: "warning", value: beats.length, threshold: 0, pass: beats.length === 0, detail_beats: beats };
}

export const visualKindCheck: L0Check = ({ script }) => [gapRow(visualGapBeats(script))];
