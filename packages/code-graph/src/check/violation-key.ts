import type { CheckViolation } from "./types.js";

/** The fields that identify a violation; a finding read back from an export carries them too. */
export type ViolationIdentity = Pick<CheckViolation, "ruleId" | "nodeId" | "destinationId">;

/** Identity of a violation across snapshots: severity, value and message may change, the key does not. */
export function violationKey(v: ViolationIdentity): string {
  return v.destinationId ? `${v.ruleId}|${v.nodeId}|${v.destinationId}` : `${v.ruleId}|${v.nodeId}`;
}

/** {@link violationKey} with both node ids carried into another snapshot's id space; unmoved ids key as before. */
export function rebasedViolationKey(v: ViolationIdentity, resolve: (id: string) => string): string {
  const destinationId = v.destinationId ? resolve(v.destinationId) : v.destinationId;
  return violationKey({ ...v, nodeId: resolve(v.nodeId), destinationId });
}
