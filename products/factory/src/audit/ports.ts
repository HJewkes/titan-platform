import type { ZodType } from "zod";
import type { AgentStepName } from "./manifest.js";
import type { MetricQuery, StoreInventory, StoreRef } from "./schemas.js";

export interface AuditAgentRequest {
  step: AgentStepName;
  model: string;
  prompt: string;
  schema: ZodType;
  signal: AbortSignal;
}

/** One structured model call; returns the parsed answer, which the step's schema checks again. */
export type AuditAgent = (request: AuditAgentRequest) => Promise<unknown>;

/** Everything the audit touches outside its own run, so tests inject fakes and no test calls a model. */
export interface AuditPorts {
  /** Area ids of the area registry (`scripts/areas.mjs`). */
  areas(): Promise<readonly string[]>;
  /** The area's current registry entry, or null before its first audit. */
  prior(system: string): Promise<unknown>;
  codeRev(): Promise<string>;
  now(): number;
  /** Never throws for an unreadable store: the inventory records the error. */
  inventory(store: StoreRef, signal: AbortSignal): Promise<StoreInventory>;
  /** Throws when the query fails, so the baseline records an error and never a zero. */
  query(store: StoreRef, query: MetricQuery, signal: AbortSignal): Promise<{ value: number | null; n: number }>;
  /** Runs a declared surface command read-only and returns its output. */
  surface(command: string, signal: AbortSignal): Promise<string>;
  agent: AuditAgent;
  writeReport(path: string, json: string): Promise<void>;
}
