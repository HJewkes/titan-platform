import type { LedgerAction } from "./apply.js";
import type { ClaimKey } from "./ops.js";
import { STALL_CODES, type ExceptionClass, type StallCode } from "./vocab.js";

/** The code of highest precedence among `codes`, absent when there is none. */
export const firstCode = (codes: readonly StallCode[]): StallCode | undefined =>
  STALL_CODES.find((code) => codes.includes(code));

/** The exception class each stall code parks its claim under. */
export const PARK_CLASS: Readonly<Record<StallCode, ExceptionClass>> = {
  "spawn-never-landed": "stalled",
  "shepherd-ended": "failed",
  "planner-refused": "failed",
  "retry-spent": "failed",
  budget: "failed",
  "outside-owns": "failed",
  "phase-timeout": "stalled",
  "dirty-uncommitted": "stalled",
  "lease-expired": "stalled",
  "no-progress": "stalled",
};

/** The one shape of a park: the claim's stall patch with its class taken from the code. */
export const parkUpdate = (
  key: ClaimKey,
  code: StallCode,
  detail: string,
): Extract<LedgerAction, { kind: "update" }> => ({
  kind: "update",
  key,
  patch: { stalledReason: `${code}: ${detail}`, stalledClass: PARK_CLASS[code], stallCode: code },
});
