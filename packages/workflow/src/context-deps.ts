import type { GateStore } from "@titan-design/hitl";
import type { TemplateRenderer } from "./prompt.js";
import type { WorkflowAuthorityOptions } from "./runtime-options.js";
import type { SignalParser } from "./signals.js";
import type { ActiveStep, DurableStepOutcome, RecoverableActiveStep, StepResult, StepRunner, StepUsage, WorkflowEvent, WorkflowRun } from "./types.js";

/** What a step run produced, before the context turns it into a recorded result. */
export interface CompletedStep {
  output: string;
  runnerRef: string | null;
  usage?: StepUsage;
  /** The attempt that succeeded, counted from 0 across retries and recovery. */
  attempt: number;
}

/** What one call position found in the record: its iteration, its key, and the row if it recorded one. */
export interface Memo {
  index: number;
  key: string;
  cached: StepResult | undefined;
}

export type RecoveredStep =
  | { kind: "completion"; step: ActiveStep; completion: Promise<DurableStepOutcome> }
  | { kind: "retry_safe"; step: RecoverableActiveStep };

export interface ContextDeps {
  gates: GateStore;
  runner: StepRunner;
  render: TemplateRenderer;
  parseSignal: SignalParser;
  emit: (event: WorkflowEvent) => void;
  maxRetries: number;
  gatePollMs: number;
  maxStepDataBytes: number;
  executionId: () => string;
  save: (run: WorkflowRun) => void;
  recovered: ReadonlyMap<string, RecoveredStep>;
  authority?: WorkflowAuthorityOptions;
  /** Refuse a replay that makes a live call while the prior drive's records remain unread. */
  strictReplay?: boolean;
}
