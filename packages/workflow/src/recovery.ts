import type { RecoveredStep } from "./context.js";
import type {
  ActiveStep,
  LegacyStepRunner,
  RecoverableStepRunner,
  StepRunner,
  WorkflowEvent,
  WorkflowRun,
} from "./types.js";

interface ReconcileOptions {
  runner: StepRunner;
  signal: AbortSignal;
  timeoutMs: number;
  now: () => string;
  emit: (event: WorkflowEvent) => void;
}

export async function reconcileActiveSteps(
  run: WorkflowRun,
  options: ReconcileOptions,
): Promise<Map<string, RecoveredStep> | null> {
  const steps = Object.values(run.activeSteps);
  if (steps.length === 0) return new Map();
  const operations = isRecoverable(options.runner)
    ? steps.map((step) => reconcileRecoverable(options.runner as RecoverableStepRunner, step, options))
    : steps.map((step) => reconcileLegacy(options.runner as LegacyStepRunner, step, options));
  const settled = await Promise.allSettled(operations);
  const recovered = collectReconciled(run, steps, settled, options);
  if (!recovered) return null;
  if (run.status === "recovery_required") {
    run.status = "running";
    run.error = null;
    for (const value of recovered.values()) delete value.step.recovery;
  }
  return recovered;
}

export function markStepRecovery(
  step: ActiveStep,
  kind: NonNullable<ActiveStep["recovery"]>["kind"],
  evidence: string,
  observedAt: string,
): void {
  step.recovery = { kind, evidence, observedAt };
}

async function reconcileRecoverable(
  runner: RecoverableStepRunner,
  step: ActiveStep,
  options: ReconcileOptions,
): Promise<RecoveredStep | null> {
  if (step.kind !== "recoverable") return null;
  const outcome = await withTimeout((signal) => runner.reconcile(step, signal), options);
  if (outcome.kind === "running") {
    void outcome.completion.catch(() => undefined);
    if (!outcome.runnerRef.trim()) {
      markStepRecovery(step, "unknown", "reconcile returned an empty runner reference", options.now());
      return null;
    }
    step.runnerRef = outcome.runnerRef;
    return { kind: "completion", step, completion: outcome.completion };
  }
  if (outcome.kind === "terminal") {
    return { kind: "completion", step, completion: Promise.resolve(outcome.outcome) };
  }
  if (outcome.kind === "not_found" && outcome.retrySafe) return { kind: "retry_safe", step };
  const kind = outcome.kind === "ownership_lost" ? "ownership_lost" : outcome.kind === "not_found" ? "not_found" : "unknown";
  markStepRecovery(step, kind, outcome.evidence, options.now());
  return null;
}

async function reconcileLegacy(
  runner: LegacyStepRunner,
  step: ActiveStep,
  options: ReconcileOptions,
): Promise<RecoveredStep | null> {
  const outcome = await withTimeout(
    (signal) => Promise.resolve(runner.attach?.(step, signal)),
    options,
  );
  if (outcome?.ok) {
    return { kind: "completion", step, completion: Promise.resolve({ kind: "succeeded", output: outcome.output }) };
  }
  const evidence = outcome ? `legacy attach failed: ${outcome.error}` : "runner cannot reconcile work after restart";
  markStepRecovery(step, "legacy_unrecoverable", evidence, options.now());
  return null;
}

function collectReconciled(
  run: WorkflowRun,
  steps: ActiveStep[],
  settled: PromiseSettledResult<RecoveredStep | null>[],
  options: ReconcileOptions,
): Map<string, RecoveredStep> | null {
  const recovered = new Map<string, RecoveredStep>();
  let blocked = false;
  settled.forEach((result, index) => {
    const step = steps[index]!;
    if (result.status === "fulfilled" && result.value) recovered.set(step.iterKey, result.value);
    else {
      const evidence = result.status === "rejected"
        ? `reconcile rejected: ${messageOf(result.reason)}`
        : step.recovery?.evidence ?? "reconciliation produced no safe action";
      const kind = step.recovery?.kind ?? "unknown";
      markRecovery(run, step, kind, evidence, options);
      blocked = true;
    }
  });
  return blocked ? null : recovered;
}

function markRecovery(
  run: WorkflowRun,
  step: ActiveStep,
  kind: NonNullable<ActiveStep["recovery"]>["kind"],
  evidence: string,
  options: ReconcileOptions,
): void {
  markStepRecovery(step, kind, evidence, options.now());
  run.status = "recovery_required";
  run.error = evidence;
  options.emit({ type: "workflow_recovery_required", runId: run.id, stepId: step.stepId, evidence });
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: ReconcileOptions,
): Promise<T> {
  const timeoutController = new AbortController();
  const boundedSignal = AbortSignal.any([options.signal, timeoutController.signal]);
  const timeout = new ReconcileTimeout(options.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timeoutController.abort(timeout);
      reject(timeout);
    }, options.timeoutMs);
  });
  timer?.unref?.();
  try {
    return await Promise.race([Promise.resolve().then(() => operation(boundedSignal)), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isRecoverable(runner: StepRunner): runner is RecoverableStepRunner {
  return "dispatch" in runner && "reconcile" in runner;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ReconcileTimeout extends Error {
  constructor(milliseconds: number) {
    super(`reconciliation timed out after ${milliseconds}ms`);
    this.name = "ReconcileTimeout";
  }
}
