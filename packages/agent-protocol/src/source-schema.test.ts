import { describe, expect, it } from "vitest";
import { SessionSourceDescriptorSchema, SourceTextLocatorSchema, UsageMeasurementSchema } from "./source-schema.js";

const descriptor = {
  sourceId: "source-1",
  harness: "codex",
  format: "rollout",
  formatVersion: null,
  path: "/scratch/rollout.jsonl",
  namespace: "host",
  conversation: { harness: "codex", namespace: "host", nativeId: "n-1", futureConversationKey: 1 },
  provenance: { kind: "codex-rollout", sessionTreeId: null, historyMode: "unknown", futureProvenanceKey: true },
  futureKey: "kept",
};

const locator = {
  source: descriptor,
  evidence: {
    line: { sourceId: "source-1", byteOffset: 0, byteLength: 10, contentHash: "h", lineNumber: 1, nativeOrdinal: null },
    subrecord: { index: 0, path: ["payload", 0] },
  },
  selector: { kind: "subrecord-text", path: ["text"], futureSelectorKey: "kept" },
  futureLocatorKey: "kept",
};

const usage = {
  kind: "delta",
  responseId: "r1",
  model: null,
  tokens: { input: 1, output: 2, cachedInput: null, cacheWriteInput: null, reasoningOutput: null, total: 3, futureTokenKey: 4 },
  cost: null,
  source: "codex",
  futureUsageKey: "kept",
};

describe("source schemas", () => {
  it("unknown keys survive", () => {
    expect(SessionSourceDescriptorSchema.parse(descriptor)).toEqual(descriptor);
    expect(SourceTextLocatorSchema.parse(locator)).toEqual(locator);
    expect(UsageMeasurementSchema.parse(usage)).toEqual(usage);
  });

  it("rejects a descriptor with only a path, a locator with no evidence, and usage with no tokens", () => {
    expect(SessionSourceDescriptorSchema.safeParse({ path: "/scratch/rollout.jsonl" }).success).toBe(false);
    expect(SourceTextLocatorSchema.safeParse({ source: descriptor, selector: locator.selector }).success).toBe(false);
    expect(UsageMeasurementSchema.safeParse({ kind: "delta", responseId: "r1" }).success).toBe(false);
  });
});
