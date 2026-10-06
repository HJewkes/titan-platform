import type { GateAnswerAllowance } from "@titan-design/hitl";

/**
 * The only answers a non-owner class may give a factory gate. Owner decision 2026-10-05 (TP-1720): a
 * coordinator may retry a stuck-behind gate. Abandon, and every other gate, stay owner-only.
 */
export const FACTORY_ANSWER_ALLOWANCES: readonly GateAnswerAllowance[] = Object.freeze([
  Object.freeze({ resolverClass: "coordinator", stepId: "stuck-behind", payload: Object.freeze({ decision: "retry" }) } as const),
]);
