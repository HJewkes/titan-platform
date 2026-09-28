import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ExecutionPhase, UsageMeasurement } from "../index.js";
import {
  TRACE_RECORD_KINDS,
  TraceRecordSchema,
  parseTraceRecord,
  parseTraceRecordLoose,
  type TraceAttempt,
  type TraceCost,
  type TraceRecord,
  type TranscriptSpan,
} from "./index.js";

const FIXTURES = new URL("../../fixtures/trace/v1/", import.meta.url);
const docRun = readFileSync(new URL("doc-run.jsonl", FIXTURES), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
const byKind = (kind: string) => JSON.parse(readFileSync(new URL(`${kind}.json`, FIXTURES), "utf8")) as Record<string, unknown>[];
const fixture = (id: string) => structuredClone(docRun.find((record) => record.id === id)!);
const ATTEMPT = "workflow:3f1c2a9e-0000-4000-8000-000000000001:draft:0:0";

/** Copied from session-read's SourceLineEvidence: agent-protocol sits below session-read and cannot import it. */
interface SourceLineEvidence {
  sourceId: string;
  byteOffset: number;
  byteLength: number;
  contentHash: string;
  lineNumber: number | null;
  nativeOrdinal: number | null;
}

describe("trace fixtures for the documentation run", () => {
  it("round-trips every record through the strict parser unchanged", () => {
    for (const record of docRun) expect(JSON.parse(JSON.stringify(parseTraceRecord(record)))).toEqual(record);
  });

  it("covers every record kind, and the per-kind files hold exactly the run's records", () => {
    expect(new Set(docRun.map((record) => record.kind))).toEqual(new Set(TRACE_RECORD_KINDS));
    expect(TRACE_RECORD_KINDS.flatMap(byKind)).toHaveLength(docRun.length);
    for (const kind of TRACE_RECORD_KINDS) expect(byKind(kind)).toEqual(docRun.filter((record) => record.kind === kind));
  });

  it("keeps the documented total cost as the sum of attempt usage", () => {
    const attempts = docRun.map((record) => parseTraceRecord(record)).filter((record): record is TraceAttempt => record.kind === "attempt");
    expect(attempts.reduce((sum, attempt) => sum + (attempt.usage?.costUsd ?? 0), 0)).toBeCloseTo(0.47);
  });
});

describe("strict and loose parsing", () => {
  it("rejects an unknown key when producing, at the top level and nested", () => {
    expect(() => parseTraceRecord({ ...fixture(ATTEMPT), extra: 1 })).toThrow();
    const cost = fixture("cost:response:claude-code:host-a:conv-1:msg_01") as { measurement: Record<string, unknown> };
    cost.measurement.extra = 1;
    expect(() => parseTraceRecord(cost)).toThrow();
  });

  it("keeps an unknown key when consuming", () => {
    expect(parseTraceRecordLoose({ ...fixture(ATTEMPT), extra: 1 })).toMatchObject({ kind: "attempt", extra: 1 });
  });

  it("returns an unknown kind or artifact kind as unknown instead of throwing", () => {
    const future = { ...fixture(ATTEMPT), kind: "handoff" };
    expect(parseTraceRecordLoose(future)).toEqual({ kind: "unknown", value: future });
    const artifact = { ...fixture("pr:acme/docs#12"), artifactKind: "release" };
    expect(parseTraceRecordLoose(artifact)).toEqual({ kind: "unknown", value: artifact });
  });

  it("still rejects a known kind that is malformed when consuming", () => {
    expect(() => parseTraceRecordLoose({ ...fixture(ATTEMPT), attempt: -1 })).toThrow();
  });

  it("checks gate ids against the grammar of their gate kind", () => {
    const human = fixture("3f1c2a9e-0000-4000-8000-000000000001/owner-review");
    expect(() => parseTraceRecord({ ...human, gateKind: "policy" })).toThrow(/policy gate grammar/);
  });

  it("rejects a record without the v1 schema tag", () => {
    expect(TraceRecordSchema.safeParse({ ...fixture(ATTEMPT), schema: "titan.trace/v0" }).success).toBe(false);
  });
});

describe("types line up with the contracts the trace reuses", () => {
  it("uses the execution phase and usage measurement types unchanged", () => {
    expectTypeOf<NonNullable<TraceAttempt["phase"]>>().toEqualTypeOf<ExecutionPhase>();
    expectTypeOf<TraceCost["measurement"]>().toExtend<UsageMeasurement>();
    expectTypeOf<UsageMeasurement>().toExtend<TraceCost["measurement"]>();
    expectTypeOf<TraceRecord["kind"]>().toEqualTypeOf<(typeof TRACE_RECORD_KINDS)[number]>();
  });

  it("accepts session-read line evidence as a transcript span without mapping", () => {
    expectTypeOf<SourceLineEvidence>().toExtend<TranscriptSpan>();
    expectTypeOf<keyof TranscriptSpan>().toEqualTypeOf<"sourceId" | "byteOffset" | "byteLength" | "contentHash">();
  });
});
