import type { ExecutionLedger } from "@titan-design/agent-lifecycle";
import type { ExecutionOwnerFence, ExecutionRecord, ExecutionTransition } from "@titan-design/agent-protocol";
import type { Harness, HarnessRunResult } from "./harness-contracts.js";
import type { DurableDispatchInput, DurableHarnessSuccess, DurableSettlement } from "./durable-types.js";

export type StoredSuccess<H extends Harness> = DurableHarnessSuccess<unknown, H>;

export interface LiveExecution<H extends Harness> {
  fence: ExecutionOwnerFence;
  controller: AbortController;
  completion: Promise<DurableSettlement<unknown, H>>;
  timer: ReturnType<typeof globalThis.setInterval>;
  externalSignal?: AbortSignal;
  onExternalAbort?: () => void;
  adapterExecutionId?: string;
  problem?: { kind: "ownership_lost" | "recovery_required"; evidence: string };
  problemPromise: Promise<NonNullable<LiveExecution<H>["problem"]>>;
  resolveProblem: (problem: NonNullable<LiveExecution<H>["problem"]>) => void;
}

type WithoutEnvelope<T> = T extends unknown
  ? Omit<T, "executionId" | "eventId" | "expectedRevision" | "occurredAt">
  : never;

export type TransitionFields<H extends Harness> = WithoutEnvelope<
  Exclude<ExecutionTransition<StoredSuccess<H>>, { kind: "prepare" }>
>;

export function failureKind(kind: string): "ownership_lost" | "recovery_required" {
  return kind === "ownership_lost" || kind === "revision_conflict" ? "ownership_lost" : "recovery_required";
}

export function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive finite number`);
}

export function nonempty(name: string, value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${name} must be a nonempty string`);
}

export function recordFence(record: ExecutionRecord<unknown>): ExecutionOwnerFence {
  if (!record.owner) throw new Error("execution has no active owner");
  return { supervisorId: record.owner.supervisorId, generation: record.owner.generation };
}

export function ownsLiveFence(record: ExecutionRecord<unknown>, fence: ExecutionOwnerFence, now: number): boolean {
  return record.owner?.supervisorId === fence.supervisorId
    && record.owner.generation === fence.generation
    && Date.parse(record.owner.leaseUntil) > now;
}

export function validateDispatchInput<H extends Harness>(
  input: DurableDispatchInput<H, unknown>,
  adapterHarness: H,
): void {
  nonempty("executionId", input.executionId);
  nonempty("requestKey", input.requestKey);
  if (input.request.harness !== adapterHarness) throw new TypeError("request harness does not match adapter");
}

export function startLiveExecution<H extends Harness>(options: {
  fence: ExecutionOwnerFence;
  controller: AbortController;
  externalSignal?: AbortSignal;
  schedule: typeof globalThis.setInterval;
  renewEveryMs: number;
  onRenew: () => void;
  onExternalAbort: () => void;
}): LiveExecution<H> {
  let resolveProblem!: LiveExecution<H>["resolveProblem"];
  const problemPromise = new Promise<NonNullable<LiveExecution<H>["problem"]>>((resolve) => { resolveProblem = resolve; });
  const timer = options.schedule(options.onRenew, options.renewEveryMs);
  if (typeof timer === "object") timer.unref?.();
  const live: LiveExecution<H> = {
    fence: options.fence,
    controller: options.controller,
    completion: Promise.resolve(undefined as never),
    problemPromise,
    resolveProblem,
    timer,
    ...(options.externalSignal ? { externalSignal: options.externalSignal, onExternalAbort: options.onExternalAbort } : {}),
  };
  options.externalSignal?.addEventListener("abort", options.onExternalAbort, { once: true });
  return live;
}

export async function raceLiveResult<T, H extends Harness>(
  result: Promise<HarnessRunResult<T, H>>,
  live: LiveExecution<H>,
): Promise<{ kind: "result"; result: HarnessRunResult<T, H> } | { kind: "problem"; problem: NonNullable<LiveExecution<H>["problem"]> }> {
  return Promise.race([
    result.then((value) => ({ kind: "result" as const, result: value })),
    live.problemPromise.then((problem) => ({ kind: "problem" as const, problem })),
  ]);
}

export function readLedgerRecord<H extends Harness>(
  ledger: Pick<ExecutionLedger<StoredSuccess<H>>, "get">,
  executionId: string,
): { ok: true; record: ExecutionRecord<StoredSuccess<H>> | undefined } | { ok: false; evidence: string } {
  try { return { ok: true, record: ledger.get(executionId) }; }
  catch (error) { return { ok: false, evidence: `execution ledger read failed: ${message(error)}` }; }
}

export function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
