import { describe, expect, expectTypeOf, it } from "vitest";
import type { NormalizedSessionObservation, ReadSessionObservationOptions, SessionObservationReadResult, SessionSourceDescriptor } from "./index.js";

describe("shared transcript source contracts", () => {
  it("represents a third harness source and preserves unknown observations", () => {
    const source: SessionSourceDescriptor = {
      sourceId: "third-source", harness: "fixture-third", namespace: "fixture-host", format: "third-jsonl",
      formatVersion: null, path: "/fixture/transcript.jsonl",
      conversation: { harness: "fixture-third", namespace: "fixture-host", nativeId: "same-id" },
      provenance: { kind: "native", name: "fixture-third" },
    };
    const observation: NormalizedSessionObservation = {
      kind: "unknown", conversation: source.conversation, nativeKind: "future-record", value: { opaque: true },
      id: { sourceId: source.sourceId, byteOffset: 0, subrecordIndex: 0 }, historyOrigin: null, timestamp: null,
      evidence: {
        line: { sourceId: source.sourceId, byteOffset: 0, byteLength: 1, contentHash: "fixture", lineNumber: null, nativeOrdinal: null },
        subrecord: { index: 0, path: [] },
      },
    };
    expect(observation).toMatchObject({ kind: "unknown", timestamp: null, nativeKind: "future-record" });
    expect(source.conversation.namespace).toBe("fixture-host");
  });

  it("keeps continuation boundary fields in the read options and results", () => {
    const options: ReadSessionObservationOptions = { from: { byteOffset: 2, prefixHash: "prefix" }, untilByteOffset: 5 };
    const result: SessionObservationReadResult = {
      startByteOffset: 2, resumeBoundary: { byteOffset: 5, prefixHash: "next" }, restartedFromZero: false,
    };
    expect(options.from?.prefixHash).toBe("prefix");
    expect(result.resumeBoundary).toEqual({ byteOffset: 5, prefixHash: "next" });
    expectTypeOf(result.restartedFromZero).toEqualTypeOf<boolean>();
  });
});
