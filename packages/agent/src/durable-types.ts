import type { ExecutionLedger } from "@titan-design/agent-lifecycle";
import type {
  AgentIdentity,
  ExecutionReconcileOutcome,
  ExecutionRecord,
  ExecutionTerminal,
} from "@titan-design/agent-protocol";
import type {
  Harness,
  HarnessAdapter,
  HarnessRunOutput,
  HarnessRunRequestFor,
  TranscriptSourceHint,
} from "./harness-contracts.js";
import type { ConversationIdentity, ExecutionIdentity, UsageMeasurement } from "@titan-design/agent-protocol";

export interface DurableHarnessSuccess<T = unknown, H extends Harness = Harness> {
  harness: H;
  adapterExecution: ExecutionIdentity;
  conversation: ConversationIdentity;
  output: HarnessRunOutput<T>;
  usage: readonly UsageMeasurement[];
  transcript?: TranscriptSourceHint;
}

export type DurableHarnessRecord<H extends Harness = Harness> = ExecutionRecord<DurableHarnessSuccess<unknown, H>>;

export type DurableSettlement<T = unknown, H extends Harness = Harness> =
  | {
      kind: "terminal";
      record: ExecutionRecord<DurableHarnessSuccess<T, H>>;
      terminal: ExecutionTerminal<DurableHarnessSuccess<T, H>>;
    }
  | { kind: "recovery_required"; record: DurableHarnessRecord<H>; evidence: string }
  | { kind: "ownership_lost"; record?: DurableHarnessRecord<H>; evidence: string };

export interface DurableDispatchInput<H extends Harness, T = string> {
  executionId: string;
  requestKey: string;
  agent?: AgentIdentity;
  request: HarnessRunRequestFor<H, T>;
}

export interface DurableDispatchAck<T = unknown, H extends Harness = Harness> {
  executionId: string;
  requestKey: string;
  runnerRef: string;
  completion: Promise<DurableSettlement<T, H>>;
}

export interface DurableLiveHandle<T = unknown, H extends Harness = Harness> {
  runnerRef: string;
  completion: Promise<DurableSettlement<T, H>>;
}

export type DurableReconcileOutcome<H extends Harness = Harness> = ExecutionReconcileOutcome<
  DurableHarnessSuccess<unknown, H>,
  DurableLiveHandle<unknown, H>
>;

export type DurableCancelResult<H extends Harness = Harness> =
  | { kind: "requested"; record: DurableHarnessRecord<H> }
  | { kind: "not_live"; evidence: string }
  | { kind: "ownership_lost"; record?: DurableHarnessRecord<H>; evidence: string };

export interface DurableHarnessDispatcher<H extends Harness> {
  readonly adapter: HarnessAdapter<H>;
  dispatch<T>(input: DurableDispatchInput<H, T>): Promise<DurableDispatchAck<T, H>>;
  reconcile(executionId: string): Promise<DurableReconcileOutcome<H>>;
  cancel(executionId: string, reason: string): DurableCancelResult<H>;
}

export interface DurableHarnessDispatcherOptions<H extends Harness> {
  ledger: ExecutionLedger<DurableHarnessSuccess<unknown, H>>;
  supervisorId: string;
  leaseMs: number;
  renewEveryMs?: number;
}

export interface DurableHarnessDispatcherDeps {
  eventId?: () => string;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}
