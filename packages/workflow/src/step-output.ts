import type { ZodType } from "zod";
import type { StepOutputFailureKind } from "./types.js";

export const DEFAULT_MAX_STEP_DATA_BYTES = 65_536;

const TRACE_KEY_PREFIX = "titan.trace.";

export type ParsedStepOutput =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; kind: StepOutputFailureKind; issues: string[] };

/** Reads a dispatch's JSON output through its schema, keeping trace keys the schema does not declare, within `maxBytes`. */
export function parseStepOutput(schema: ZodType, output: string, maxBytes: number): ParsedStepOutput {
  const raw = parseJson(output);
  if (!raw.ok) return { ok: false, kind: "not_json", issues: [raw.error] };
  const parsed = schema.safeParse(raw.value);
  if (!parsed.success) return { ok: false, kind: "schema", issues: parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`) };
  if (!isRecord(parsed.data)) return { ok: false, kind: "schema", issues: ["(root): step schema must produce an object"] };
  const data = withTraceKeys(raw.value, parsed.data);
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes > maxBytes) return { ok: false, kind: "too_large", issues: [`data is ${bytes} bytes, over the ${maxBytes}-byte bound`] };
  return { ok: true, data };
}

function parseJson(output: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(output) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Trace keys feed run projections, so a stripping schema must not drop them; a key the schema declares stays the schema's. */
function withTraceKeys(raw: unknown, data: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(raw)) return data;
  const carried = Object.entries(raw).filter(([key]) => key.startsWith(TRACE_KEY_PREFIX) && !Object.hasOwn(data, key));
  return carried.length === 0 ? data : { ...data, ...Object.fromEntries(carried) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
