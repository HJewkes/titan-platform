import type { ExecutionLedger } from "@titan-design/agent-lifecycle";
import { isTerminalExecutionPhase, type ExecutionOwnerFence, type ExecutionTerminal } from "@titan-design/agent-protocol";
import {
  message,
  ownsLiveFence,
  readLedgerRecord,
  recordFence,
  type LiveExecution,
  type StoredSuccess,
  type TransitionFields,
} from "./durable-dispatcher-support.js";
import type { DurableHarnessRecord, DurableReconcileOutcome, DurableSettlement } from "./durable-types.js";
import type { Harness } from "./harness-contracts.js";

type ApplyFields<H extends Harness> = (
  record: DurableHarnessRecord<H>,
  fields: TransitionFields<H>,
) => ReturnType<ExecutionLedger<StoredSuccess<H>>["apply"]>;

export function reconcileLive<H extends Harness>(
  ledger: ExecutionLedger<StoredSuccess<H>>,
  executionId: string,
  live: LiveExecution<H>,
  now: number,
  fail: (evidence: string) => void,
): DurableReconcileOutcome<H> {
  const read = readLedgerRecord(ledger, executionId);
  const evidence = !read.ok
    ? `live ownership could not be verified: ${read.evidence}`
    : !read.record || !ownsLiveFence(read.record, live.fence, now)
      ? "live execution no longer has its captured owner lease"
      : undefined;
  if (evidence) {
    fail(evidence);
    return { kind: "ownership_lost", evidence };
  }
  return { kind: "running", running: { runnerRef: executionId, completion: live.completion }, evidence: "same dispatcher owns the completion handle" };
}

export function claimForRecovery<H extends Harness>(
  record: DurableHarnessRecord<H>,
  options: { now: number; supervisorId: string; leaseUntil: string },
  apply: ApplyFields<H>,
): { ok: true; record: DurableHarnessRecord<H> } | { ok: false; evidence: string } {
  if (record.owner && Date.parse(record.owner.leaseUntil) > options.now) return { ok: false, evidence: "another live owner lease fences recovery" };
  try {
    const result = apply(record, {
      kind: "claim_owner",
      owner: { supervisorId: options.supervisorId, generation: record.ownerGeneration + 1, leaseUntil: options.leaseUntil },
    });
    return result.ok ? { ok: true, record: result.record } : { ok: false, evidence: result.reason };
  } catch (error) {
    return { ok: false, evidence: `ownership claim failed: ${message(error)}` };
  }
}

export function closePrepared<H extends Harness>(
  record: DurableHarnessRecord<H>,
  apply: ApplyFields<H>,
): DurableReconcileOutcome<H> {
  const terminal: ExecutionTerminal<StoredSuccess<H>> = {
    outcome: "failed",
    reason: "durable preparation exists but dispatch never began",
    retryable: true,
  };
  try {
    const result = apply(record, { kind: "finish", fence: recordFence(record), terminal });
    return result.ok
      ? { kind: "terminal", terminal, evidence: "prepared phase proves begin_dispatch was never committed" }
      : { kind: "ownership_lost", evidence: result.reason };
  } catch (error) {
    return { kind: "ownership_lost", evidence: `prepared execution could not be closed: ${message(error)}` };
  }
}

export function requireRecovery<H extends Harness>(
  record: DurableHarnessRecord<H> | undefined,
  fence: ExecutionOwnerFence,
  evidence: string,
  apply: ApplyFields<H>,
): DurableSettlement<unknown, H> {
  if (!record) return { kind: "ownership_lost", evidence: "execution record is unavailable" };
  if (!record.owner || record.owner.supervisorId !== fence.supervisorId || record.owner.generation !== fence.generation) {
    return { kind: "ownership_lost", record, evidence: "execution ownership changed before recovery evidence could be stored" };
  }
  if (record.phase === "recovery_required") return { kind: "recovery_required", record, evidence };
  if (isTerminalExecutionPhase(record.phase)) return { kind: "terminal", record, terminal: record.terminal! };
  try {
    const result = apply(record, { kind: "require_recovery", fence, evidence });
    return result.ok ? { kind: "recovery_required", record: result.record, evidence } : { kind: "ownership_lost", record, evidence: result.reason };
  } catch (error) {
    return { kind: "ownership_lost", record, evidence: `recovery evidence was not durable: ${message(error)}` };
  }
}
