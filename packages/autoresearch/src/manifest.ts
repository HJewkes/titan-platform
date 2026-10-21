import type { StepDeclaration } from "../definition.js";

const AR_DISPATCH_STEPS = ["pin", "eval", "plan", "alloc", "implement", "l0", "l1", "ratchet", "release"] as const;
export type ArDispatchStep = (typeof AR_DISPATCH_STEPS)[number];

/** Pure decisions recorded so a replay reads them back instead of recomputing: the queue, the draws, each idea's stop. */
const AR_SEED_STEPS = ["queue", "select", "stop"] as const;
type ArSeedStep = (typeof AR_SEED_STEPS)[number];

export const arStepId = (name: ArDispatchStep | ArSeedStep): string => `ar-${name}`;

export const AUTORESEARCH_STEPS: readonly StepDeclaration[] = [
  ...AR_DISPATCH_STEPS.map((name) => ({ id: arStepId(name), kind: "dispatch" as const })),
  ...AR_SEED_STEPS.map((name) => ({ id: arStepId(name), kind: "seed" as const })),
];
