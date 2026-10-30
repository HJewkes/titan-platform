import type { WakeOutcome, WakeRequest } from "./phases.js";

/** Only a review's send-back holds; a ci-red or conflict wake no fixer took keeps its own route: the ci-failed gate or the not-mergeable stop. */
export const HOLDING_KINDS: ReadonlySet<WakeRequest["kind"]> = new Set(["review", "fix-proof"]);

/**
 * A send-back whose successor agent-chat refused to start. No agent took it, so `afterWake` routes it as a fixer's exit
 * with no push: a seat notice and a wait, or else the owner gate.
 */
export type HeldWake = Extract<WakeOutcome, { kind: "unhandled" }> & { held: { agent: string } };

export const isHeld = (outcome: WakeOutcome): outcome is HeldWake => "held" in outcome && outcome.held !== undefined;
