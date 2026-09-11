import type { ExecutionTerminal } from "@titan-design/agent-protocol";
import type { Harness, HarnessRunFailure, HarnessRunResult } from "./harness-contracts.js";
import type { DurableHarnessSuccess } from "./durable-types.js";

export function terminalFromHarnessResult<T, H extends Harness>(
  result: HarnessRunResult<T, H>,
): ExecutionTerminal<DurableHarnessSuccess<T, H>> {
  if (result.ok) {
    return {
      outcome: "succeeded",
      result: {
        harness: result.harness,
        adapterExecution: result.execution,
        conversation: result.conversation,
        output: result.output,
        usage: result.usage,
        ...(result.transcript ? { transcript: result.transcript } : {}),
      },
    };
  }
  const reason = `${result.failure.kind}: ${result.failure.reason}`;
  if (result.failure.kind === "aborted" || result.failure.kind === "cancelled_unknown" || result.failure.kind === "wall_time_exceeded") {
    return { outcome: "cancellation_unknown", reason, evidence: cancellationEvidence(result.failure) };
  }
  // The shared failure contract does not prove the native invocation was absent.
  return { outcome: "failed", reason, retryable: false };
}

function cancellationEvidence(failure: HarnessRunFailure): string {
  if (failure.kind === "wall_time_exceeded") return "wall deadline elapsed after durable dispatch without a native terminal acknowledgement";
  return failure.kind === "cancelled_unknown"
    ? "adapter reported cancellation without a native terminal acknowledgement"
    : "adapter was aborted after durable dispatch without a native terminal acknowledgement";
}
