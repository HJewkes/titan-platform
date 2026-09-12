import type { ExecutionRecord, ExecutionTransition } from "@titan-design/agent-protocol";

export type ApplyExecutionTransitionResult<TResult = unknown> =
  | { ok: true; applied: boolean; record: ExecutionRecord<TResult> }
  | { ok: false; kind: "not_found" | "revision_conflict" | "event_conflict" | "invalid_transition" | "ownership_lost";
      reason: string; current?: ExecutionRecord<TResult> };

export interface ExecutionLedger<TResult = unknown> {
  get(executionId: string): ExecutionRecord<TResult> | undefined;
  findByRequestKey(requestKey: string): ExecutionRecord<TResult> | undefined;
  listRecoverable(limit?: number): ExecutionRecord<TResult>[];
  apply(transition: ExecutionTransition<TResult>): ApplyExecutionTransitionResult<TResult>;
  events(executionId: string): readonly ExecutionTransition<TResult>[];
}

export interface SqliteExecutionLedgerOptions {
  table?: string;
  /** Trusted ledger clock, distinct from a caller-supplied event timestamp. */
  now?: () => string;
}
