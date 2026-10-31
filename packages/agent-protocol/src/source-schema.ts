import { z } from "zod";
import type { UsageMeasurement } from "./index.js";
import type { SessionSourceDescriptor, SourceTextLocator } from "./harness/source.js";

// Loose objects throughout: rows written by a newer writer keep their unknown keys.
// Constraints mirror the TypeScript types only, so no row the types accept is rejected.
const text = z.string();
const count = z.number();
const nullableCount = count.nullable();
const path = z.array(z.union([text, count]));

const conversation = z.looseObject({ harness: text, namespace: text, nativeId: text });

const provenance = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("claude-code-transcript"), legacySessionId: text }),
  z.looseObject({
    kind: z.literal("codex-rollout"),
    sessionTreeId: text.nullable(),
    historyMode: z.enum(["legacy", "paginated", "unknown"]),
  }),
  z.looseObject({ kind: z.literal("native"), name: text, details: z.record(z.string(), z.unknown()).optional() }),
]);

/** Reads a stored source descriptor. */
export const SessionSourceDescriptorSchema: z.ZodType<SessionSourceDescriptor> = z.looseObject({
  sourceId: text,
  harness: text,
  format: text,
  formatVersion: text.nullable(),
  path: text,
  namespace: text,
  conversation,
  provenance,
});

const evidence = z.looseObject({
  line: z.looseObject({
    sourceId: text,
    byteOffset: count,
    byteLength: count,
    contentHash: text,
    lineNumber: nullableCount,
    nativeOrdinal: nullableCount,
  }),
  subrecord: z.looseObject({ index: count, path }),
});

/** Reads a stored text locator. */
export const SourceTextLocatorSchema: z.ZodType<SourceTextLocator> = z.looseObject({
  source: SessionSourceDescriptorSchema,
  evidence,
  selector: z.looseObject({ kind: z.literal("subrecord-text"), path, textIndex: count.optional() }),
});

const tokens = z.looseObject({
  input: nullableCount,
  output: nullableCount,
  cachedInput: nullableCount,
  cacheWriteInput: nullableCount,
  reasoningOutput: nullableCount,
  total: nullableCount,
});
const usageBase = {
  model: text.nullable(),
  tokens,
  cost: z.looseObject({ usd: count, kind: z.enum(["estimate", "reported"]) }).nullable(),
  source: text,
};

/**
 * Reads a stored usage measurement. Unlike the trace subpath's producer schema, unknown keys
 * pass and values are not range-checked, so a reader never drops a row a writer accepted.
 */
export const UsageMeasurementSchema: z.ZodType<UsageMeasurement> = z.union([
  z.looseObject({ ...usageBase, kind: z.literal("delta"), responseId: text }),
  z.looseObject({
    ...usageBase,
    kind: z.literal("snapshot"),
    scope: z.enum(["turn", "conversation"]),
    scopeId: text,
    epoch: text,
    sequence: count,
  }),
]);
