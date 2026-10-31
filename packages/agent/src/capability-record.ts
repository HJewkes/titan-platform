import type { CapabilityAssessment, ExecutionCapability } from "./harness-contracts.js";

/** Spelled out key by key so the compiler proves every capability is present; no cast over `Object.fromEntries`. */
export function capabilityRecord(
  assess: (capability: ExecutionCapability) => CapabilityAssessment,
): Record<ExecutionCapability, CapabilityAssessment> {
  return {
    fresh_run: assess("fresh_run"),
    resume: assess("resume"),
    fork: assess("fork"),
    structured_output: assess("structured_output"),
    interactive_approvals: assess("interactive_approvals"),
    external_cancellation: assess("external_cancellation"),
    semantic_interrupt: assess("semantic_interrupt"),
    active_turn_steering: assess("active_turn_steering"),
    idle_turn_submission: assess("idle_turn_submission"),
    persisted_transcript: assess("persisted_transcript"),
    process_reattachment: assess("process_reattachment"),
    token_reporting: assess("token_reporting"),
  };
}
