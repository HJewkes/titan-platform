import type {
  DurableHarnessDispatcher,
  DurableHarnessSuccess,
  DurableSettlement,
  Harness,
  HarnessRunRequestFor,
} from "@titan-design/agent";
import type {
  DurableStepOutcome,
  RecoverableStepDispatchInput,
  RecoverableStepRunner,
} from "./types.js";

export interface DurableHarnessRunnerOptions<H extends Harness> {
  /** Supplies native configuration and bounds. The workflow owns the cancellation signal. */
  request(input: RecoverableStepDispatchInput): HarnessRunRequestFor<H, string>;
}

type Terminal<H extends Harness> = Extract<DurableSettlement<unknown, H>, { kind: "terminal" }>["terminal"];

function outputText(result: DurableHarnessSuccess): string {
  if (result.output.kind === "text") return result.output.text;
  if (typeof result.output.value === "string") return result.output.value;
  const text = JSON.stringify(result.output.value);
  if (text === undefined) throw new Error("Durable structured output has no text representation");
  return text;
}

function terminalOutcome<H extends Harness>(terminal: Terminal<H>): DurableStepOutcome {
  switch (terminal.outcome) {
    case "succeeded": return { kind: "succeeded", output: outputText(terminal.result) };
    case "failed": return { kind: "failed", error: terminal.reason, retryable: terminal.retryable };
    case "cancelled": return { kind: "cancelled", reason: terminal.reason };
    case "cancellation_unknown": return { kind: "cancellation_unknown", reason: terminal.reason };
  }
}

function completionOutcome<H extends Harness>(completion: Promise<DurableSettlement<unknown, H>>): Promise<DurableStepOutcome> {
  const mapped = completion.then(settlement => {
    if (settlement.kind !== "terminal") throw new Error(settlement.evidence);
    return terminalOutcome(settlement.terminal);
  });
  // A workflow can fail to persist its acknowledgment before it starts awaiting completion.
  void mapped.catch(() => undefined);
  return mapped;
}

/** Connects the harness-neutral workflow handshake to an authoritative execution ledger. */
export function durableHarnessRunner<H extends Harness>(
  dispatcher: DurableHarnessDispatcher<H>,
  options: DurableHarnessRunnerOptions<H>,
): RecoverableStepRunner {
  return {
    async dispatch(input) {
      const request = { ...options.request(input), signal: input.signal };
      const ack = await dispatcher.dispatch({ executionId: input.executionId, requestKey: input.requestKey, request });
      return { ...ack, completion: completionOutcome(ack.completion) };
    },
    async reconcile(step, signal) {
      const outcome = await dispatcher.reconcile(step.executionId);
      if (outcome.kind === "terminal") return { kind: "terminal", outcome: terminalOutcome(outcome.terminal), evidence: outcome.evidence };
      if (outcome.kind !== "running") return outcome;
      let rejectCancellation!: (reason: unknown) => void;
      const cancellationFailure = new Promise<never>((_, reject) => { rejectCancellation = reject; });
      const cancel = () => {
        try {
          const result = dispatcher.cancel(step.executionId, String(signal.reason ?? "Workflow cancelled"));
          if (result.kind === "ownership_lost") rejectCancellation(new Error(result.evidence));
        }
        catch (error) { rejectCancellation(error); }
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      const completion = Promise.race([completionOutcome(outcome.running.completion), cancellationFailure])
        .finally(() => signal.removeEventListener("abort", cancel));
      void completion.catch(() => undefined);
      return { kind: "running", runnerRef: outcome.running.runnerRef, completion, evidence: outcome.evidence };
    },
  };
}
