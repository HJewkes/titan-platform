const AR_DISPATCH_STEPS = ["pin", "eval", "plan", "alloc", "implement", "l0", "l1", "ratchet", "integrate", "release", "load-wait", "archive", "inbox", "validate", "registry"] as const;
export type ArDispatchStep = (typeof AR_DISPATCH_STEPS)[number];

/**
 * Pure decisions recorded so a replay reads them back instead of recomputing: the queue, the draws, each ladder's
 * lane slot and stop, each later winner's re-evaluation, each round's summary and why the loop ended.
 */
const AR_SEED_STEPS = ["queue", "select", "lane", "stop", "reeval", "summary", "end"] as const;
type ArSeedStep = (typeof AR_SEED_STEPS)[number];

/** A step family and the context call that runs it; a host that guards step kinds reads this. */
export interface ArStepDeclaration {
  id: string;
  kind: "dispatch" | "seed";
}

export const arStepId = (name: ArDispatchStep | ArSeedStep): string => `ar-${name}`;

export const AUTORESEARCH_STEPS: readonly ArStepDeclaration[] = [
  ...AR_DISPATCH_STEPS.map((name) => ({ id: arStepId(name), kind: "dispatch" as const })),
  ...AR_SEED_STEPS.map((name) => ({ id: arStepId(name), kind: "seed" as const })),
];
