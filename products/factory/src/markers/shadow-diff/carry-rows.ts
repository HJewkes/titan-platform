import { z } from "zod";
import type { PrKey } from "../../head-guard/epoch-store.js";
import { itemKey } from "../pins.js";
import type { CompareRow } from "./compare.js";
import { pinCause, type PinProbe } from "./pin-cause.js";

/** The fact a carried MERGE stands in for; its pin class is the family of every carry row. */
export const CARRY_FACT = "verdict:merge";

/** A MERGE Shepherd carried live, named by the step_results record (`memoKey`) whose evidence says so. */
export interface CarriedMerge {
  fromHead: string;
  head: string;
  rule: string;
  memoKey: string;
}

export type CarryProbe = (item: PrKey, fromHead: string, head: string) => Promise<PinProbe>;

// The `g10-release.ts` evidence shape, read through the code step's `data.result` wrapper; an absent rule reads as tree-equal.
const CarriedEvidence = z.looseObject({
  data: z.looseObject({
    result: z.looseObject({ record: z.looseObject({ carry: z.looseObject({ fromHead: z.string(), head: z.string(), rule: z.string().optional() }) }) }),
  }),
});

/** The carries recorded this entry, one per carried head; a carry already recorded when the entry began was compared then. */
export function carriedThisEntry(stepResults: Record<string, unknown>, recorded: readonly string[]): CarriedMerge[] {
  const before = new Set(recorded);
  const byHead = new Map<string, CarriedMerge>();
  for (const [memoKey, value] of Object.entries(stepResults)) {
    const parsed = before.has(memoKey) ? undefined : CarriedEvidence.safeParse(value).data;
    if (!parsed) continue;
    const { fromHead, head, rule } = parsed.data.result.record.carry;
    if (!byHead.has(head)) byHead.set(head, { fromHead, head, rule: rule ?? "tree-equal", memoKey });
  }
  return [...byHead.values()];
}

/** No probe is `pin-differs` with cause `unprobed`, never agreement: a shadow without git cannot pass the gate. */
export function carryRow(item: PrKey, carried: CarriedMerge, probe: PinProbe | undefined): CompareRow {
  const cause = pinCause(probe);
  const agrees = cause.class === "carry-agrees";
  const exclusion2 = agrees && cause.exclusion2;
  return {
    family: "diff",
    class: cause.class,
    ...(!agrees && { cause: cause.cause }),
    materialValid: agrees,
    fullValid: agrees && !exclusion2,
    drift: [],
    carry: { item: itemKey(item), fromHead: carried.fromHead, head: carried.head, rule: carried.rule, exclusion2 },
  };
}
