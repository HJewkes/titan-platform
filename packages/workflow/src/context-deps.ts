import type { GateStore } from "@titan-design/hitl";
import type { TemplateRenderer } from "./prompt.js";
import type { WorkflowAuthorityOptions } from "./runtime-options.js";
import type { SignalParser } from "./signals.js";
import type { ActiveStep, DurableStepOutcome, RecoverableActiveStep, StepRunner, WorkflowEvent, WorkflowRun } from "./types.js";

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
}
