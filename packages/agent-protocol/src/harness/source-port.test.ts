import { describe, expect, expectTypeOf, it } from "vitest";
import type { HarnessSourceLookup, HarnessSourcePort, SessionSourceDescriptor, SessionObservationReadResult } from "./index.js";
const source: SessionSourceDescriptor = {
  sourceId: "third-source", harness: "fixture-third", namespace: "fixture-host", format: "fixture-format",
  formatVersion: null, path: "/fixture/source", conversation: { harness: "fixture-third", namespace: "fixture-host", nativeId: "same" },
  provenance: { kind: "native", name: "fixture-third" },
};
describe("harness source port contracts", () => {
  it("keeps multiple physical sources and unknown finality for a third harness", async () => {
    const supported = { status: "supported" as const, evidence: "synthetic fixture only" };
    const unverified = { status: "unverified" as const, reason: "fixture-only" };
    const port: HarnessSourcePort = {
      capabilities: { discover: supported, locate: supported, observations: supported, text: supported, semanticFinality: unverified },
      async discover() { return [source]; },
      async locate(query) {
        expectTypeOf(query.conversation.harness).toEqualTypeOf<string>();
        return { status: "found", sources: [source, { ...source, sourceId: "archived-source", path: "/fixture/archive" }] };
      },
      async *readObservations(_source, _options, onDone) {
        yield {
          kind: "unknown", id: { sourceId: source.sourceId, byteOffset: 0, subrecordIndex: 0 },
          conversation: source.conversation, historyOrigin: null, timestamp: null, nativeKind: "fixture.future", value: null,
          evidence: { line: { sourceId: source.sourceId, byteOffset: 0, byteLength: 1, contentHash: "prefix", lineNumber: null, nativeOrdinal: null }, subrecord: { index: 0, path: [] } },
        };
        onDone?.({ startByteOffset: 0, resumeBoundary: { byteOffset: 1, prefixHash: "prefix" }, restartedFromZero: false });
      },
      async readText() { return null; },
    };
    const lookup = await port.locate({ conversation: source.conversation });
    expect(lookup.status === "found" && lookup.sources.length).toBe(2);
    const completed: SessionObservationReadResult[] = [];
    const observations = [];
    for await (const observation of port.readObservations(source, {}, result => completed.push(result))) observations.push(observation);
    expect(observations[0]).toMatchObject({ kind: "unknown", nativeKind: "fixture.future", timestamp: null });
    expect(completed[0]?.resumeBoundary).toEqual({ byteOffset: 1, prefixHash: "prefix" });
    expect(await port.readText({ source, evidence: observations[0]!.evidence, selector: { kind: "subrecord-text", path: [] } })).toBeNull();
    expect(port.capabilities.semanticFinality.status).toBe("unverified");
  });
  it("keeps not-written evidence distinct from unavailable and rejects empty known collections", () => {
    const pending: HarnessSourceLookup = { status: "not_written", expectedPaths: ["/fixture/expected"] };
    const unavailable: HarnessSourceLookup = { status: "unavailable", reason: "source unreadable" };
    // @ts-expect-error found cannot mean no verified physical source
    const emptyFound: HarnessSourceLookup = { status: "found", sources: [] };
    // @ts-expect-error not_written requires at least one expected location
    const emptyExpected: HarnessSourceLookup = { status: "not_written", expectedPaths: [] };
    expect([pending.status, unavailable.status, emptyFound.status, emptyExpected.status]).toEqual(["not_written", "unavailable", "found", "not_written"]);
  });
});
