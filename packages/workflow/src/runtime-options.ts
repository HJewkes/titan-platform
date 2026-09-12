import type { GateStore } from "@titan-design/hitl";
import type { Db } from "@titan-design/store-sqlite";
import type { TemplateRenderer } from "./prompt.js";
import type { SignalParser } from "./signals.js";
import type { StepRunner, WorkflowEvent } from "./types.js";

export interface WorkflowRuntimeOptions {
  db: Db;
  gates: GateStore;
  runner: StepRunner;
  render?: TemplateRenderer;
  parseSignal?: SignalParser;
  onEvent?: (event: WorkflowEvent) => void;
  maxRetries?: number;
  gatePollMs?: number;
  runTable?: string;
  runtimeId?: string;
  leaseMs?: number;
  reconcileTimeoutMs?: number;
  now?: () => number;
  executionId?: () => string;
}
