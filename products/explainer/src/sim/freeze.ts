import { createHash } from "node:crypto";
import { canonicalJson } from "../eval-store.js";
import type { SimSweep } from "./sweep.js";
import { SIM_TRACE_SCHEMA, SimTraceSchema, type SimTrace } from "./trace-schema.js";

/** The full sha256 of a value's canonical JSON, UTF-8. */
export const canonicalSha256 = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

export interface FrozenTrace {
  trace: SimTrace;
  /** The trace's canonical JSON, sha included: the bytes the stage store keeps. */
  json: string;
  sha: string;
}

/**
 * Seals a sweep as an `explainer.sim-trace/v1` trace keyed by its sha256 over every other field,
 * `doctrine` being the sha of the model's doctrine file. A trace the schema rejects throws.
 */
export function freezeSim(swept: SimSweep, doctrine: string): FrozenTrace {
  const body = { schema: SIM_TRACE_SCHEMA, ...swept, doctrine };
  const trace = SimTraceSchema.parse({ ...body, sha: canonicalSha256(body) });
  return { trace, json: canonicalJson(trace), sha: trace.sha };
}

/** Whether a trace's sha still matches its content: a frozen trace edited by hand does not. */
export function traceShaHolds(trace: SimTrace): boolean {
  const { sha, ...body } = trace;
  return canonicalSha256(body) === sha;
}
