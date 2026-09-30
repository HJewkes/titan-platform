import type { ActorClass, PolicyTable } from "@titan-design/authority";
import type { GateStore } from "@titan-design/hitl";
import type { Db } from "@titan-design/store-sqlite";
import type { TemplateRenderer } from "./prompt.js";
import type { SignalParser } from "./signals.js";
import type { StepRunner, WorkflowEvent } from "./types.js";

export interface WorkflowAuthorityOptions {
  /** Defaults to the authority package's `DEFAULT_TABLE`. */
  table?: PolicyTable;
  /** Who this runtime acts as in every `ctx.authorize` request. */
  actor: { class: ActorClass; id: string };
}

export interface WorkflowRuntimeOptions {
  db: Db;
  gates: GateStore;
  runner: StepRunner;
  render?: TemplateRenderer;
  parseSignal?: SignalParser;
  onEvent?: (event: WorkflowEvent) => void;
  maxRetries?: number;
  gatePollMs?: number;
  /** Largest serialised `data` a schema dispatch may store. Defaults to 64 KiB. */
  maxStepDataBytes?: number;
  runTable?: string;
  runtimeId?: string;
  leaseMs?: number;
  reconcileTimeoutMs?: number;
  now?: () => number;
  executionId?: () => string;
  /** Required by `ctx.authorize`; a run without it fails at its first authorize step. */
  authority?: WorkflowAuthorityOptions;
}
