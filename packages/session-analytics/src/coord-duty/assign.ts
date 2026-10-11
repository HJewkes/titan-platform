import { NOOP_PREFIX, type DutyRuleSet } from "./rules.js";
import type { Outcome, Trigger } from "./turn-signals.js";

/**
 * How an unclassified call inherits a duty: `dominant` takes the turn's highest-dollar classified duty
 * (TP-1550); `nearest` takes the nearest earlier classified call in the turn (the deep dive's default,
 * because a basement heartbeat batches about a dozen calls).
 */
export type InheritMode = "dominant" | "nearest";

/** A call with tools that no rule classifies. Assigned like a call with no tools, but kept apart in `raw`. */
export const OTHER_TOOL = "other-tool";

export interface AssignableCall {
  usd: number;
  /** The rule result: a duty, OTHER_TOOL, or null for a call with no tools. */
  raw: string | null;
  duty: string;
}

/** Boot turns re-read state, so these classes count as handoff there. */
const BOOT_AS_HANDOFF = new Set<string | null>([null, OTHER_TOOL, "dispatch-select", "triage-read", "pacing"]);

/** Sets `duty` on each call of one turn, in order: NO-OP turns, then boot turns, then inheritance. */
export function assignTurn(calls: AssignableCall[], trigger: Trigger, outcome: Outcome, rules: DutyRuleSet, inherit: InheritMode): void {
  if (outcome === "NO-OP" && trigger !== "boot") {
    for (const call of calls) call.duty = NOOP_PREFIX + trigger;
    return;
  }
  const dominant = dominantDuty(calls) ?? rules.triggerDefaults[trigger] ?? "other";
  let previous: string | null = null;
  for (const call of calls) {
    const duty = trigger === "boot" && BOOT_AS_HANDOFF.has(call.raw) ? "handoff" : call.raw;
    if (isClassified(duty)) {
      call.duty = duty;
      previous = duty;
    } else {
      call.duty = inherit === "nearest" && previous ? previous : dominant;
    }
  }
}

/** The classified duty with the most dollars; a tie goes to the first seen, as Counter.most_common does. */
function dominantDuty(calls: readonly AssignableCall[]): string | null {
  const usdByDuty = new Map<string, number>();
  for (const call of calls) {
    if (isClassified(call.raw)) usdByDuty.set(call.raw, (usdByDuty.get(call.raw) ?? 0) + call.usd);
  }
  let best: string | null = null;
  let bestUsd = -Infinity;
  for (const [duty, usd] of usdByDuty) {
    if (usd > bestUsd) [best, bestUsd] = [duty, usd];
  }
  return best;
}

function isClassified(duty: string | null): duty is string {
  return duty !== null && duty !== OTHER_TOOL;
}
