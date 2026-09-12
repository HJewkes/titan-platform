import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexSourceFromPath } from "./codex-discover.js";
import {
  CODEX_ROOT_TURN,
  CODEX_THREAD,
  CODEX_TREE,
  CODEX_TURN,
  codexFixtureRecords,
  codexOffsetAfter,
  renderCodexRollout,
} from "./codex-fixture.js";
import type { CodexReadResult, ReadCodexOptions } from "./codex-read.js";
import { readCodexObservations, readCodexText } from "./codex-read.js";
import { CodexRolloutDecoder } from "./codex-decoder.js";
import type {
  NormalizedMessageObservation,
  NormalizedSessionObservation,
  NormalizedToolCallObservation,
  SessionSourceDescriptor,
} from "./normalized.js";
import { TranscriptParseError } from "./read.js";
import { normalizedSearchText, SPAN_TEXT_CAP } from "./text.js";

let dir: string;
let filePath: string;
let records: Record<string, unknown>[];
let source: SessionSourceDescriptor;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-codex-read-"));
  filePath = path.join(dir, "sessions", "2026", "09", "11", "rollout-child.jsonl");
  mkdirSync(path.dirname(filePath), { recursive: true });
  records = codexFixtureRecords();
  writeFileSync(filePath, renderCodexRollout(records), "utf8");
  source = (await codexSourceFromPath(filePath, "host-a"))!;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readCodexObservations", () => {
  it("normalizes identity, turns, metadata, lineage, compaction, and unknown records", async () => {
    const { observations } = await collect(source);

    expect(source).toMatchObject({
      conversation: { nativeId: CODEX_THREAD },
      provenance: { sessionTreeId: CODEX_TREE },
    });
    expect(observations).toContainEqual(expect.objectContaining({ kind: "lineage", relationship: "parent", relatedConversation: expect.objectContaining({ nativeId: CODEX_TREE }) }));
    expect(observations).toContainEqual(
      expect.objectContaining({
        kind: "native_turn",
        phase: "observed",
        rootTurn: expect.objectContaining({ nativeId: CODEX_ROOT_TURN, conversation: expect.objectContaining({ nativeId: CODEX_TREE }) }),
      }),
    );
    expect(observations).toContainEqual(expect.objectContaining({ kind: "metadata", entries: expect.arrayContaining([expect.objectContaining({ name: "future_turn_setting", meaning: "native" })]) }));
    expect(observations).toContainEqual(expect.objectContaining({ kind: "compaction", encrypted: true }));
    expect(observations).toContainEqual(expect.objectContaining({ kind: "unknown", nativeKind: "future_envelope", value: { future_value: 42 } }));
  });

  it("prefers canonical response messages and emits unmatched projections as fallback", async () => {
    const { observations } = await collect(source);
    const messages = observations.filter((observation) => observation.kind === "message");

    expect(messages.map((message) => [message.role, message.representation, message.content.map((part) => part.text).join("\n")])).toEqual([
      ["user", "canonical", "héllo 🌍"],
      ["assistant", "canonical", "Working."],
      ["assistant", "projection-fallback", "Projection-only completion."],
    ]);
  });

  it("links interleaved tool results by conversation-scoped call IDs", async () => {
    const { observations } = await collect(source);
    const calls = observations.filter((observation) => observation.kind === "tool_call");
    const results = observations.filter((observation) => observation.kind === "tool_result");

    expect(calls.map((call) => call.call.nativeId)).toEqual(["call-1", "call-2"]);
    expect(calls.every((call) => call.turn?.nativeId === CODEX_TURN)).toBe(true);
    expect(results.map((result) => [result.call.nativeId, result.isError])).toEqual([
      ["call-2", null],
      ["call-1", null],
    ]);
    expect(results.every((result) => result.call.conversation.nativeId === CODEX_THREAD)).toBe(true);
  });

  it("keeps response deltas idempotent and cumulative usage as ordered snapshots", async () => {
    const { observations } = await collect(source);
    const usage = observations.filter((observation) => observation.kind === "usage");
    const deltas = usage.filter((observation) => observation.measurement.kind === "delta");
    const conversationSnapshots = usage.filter(
      (observation) => observation.measurement.kind === "snapshot" && observation.measurement.scope === "conversation",
    );

    expect(deltas.map((observation) => observation.response!.nativeId)).toEqual(["response-1", "response-1", "response-2"]);
    expect(new Set(deltas.map((observation) => observation.response!.nativeId)).size).toBe(2);
    expect(deltas.every((observation) => observation.measurement.model === "gpt-test")).toBe(true);
    expect(conversationSnapshots).toHaveLength(3);
    expect(conversationSnapshots.every((observation) => observation.measurement.model === null)).toBe(true);
    expect(conversationSnapshots[0]?.measurement).toMatchObject({ kind: "snapshot", sequence: 11 });
    expect(conversationSnapshots[1]?.measurement).toMatchObject({ kind: "snapshot", sequence: 13 });
    expect(conversationSnapshots[0]?.measurement.kind === "snapshot" && conversationSnapshots[1]?.measurement.kind === "snapshot"
      ? conversationSnapshots[0].measurement.epoch
      : null).toBe(conversationSnapshots[1]?.measurement.kind === "snapshot" ? conversationSnapshots[1].measurement.epoch : null);
    expect(conversationSnapshots[2]?.measurement.kind === "snapshot" && conversationSnapshots[1]?.measurement.kind === "snapshot"
      ? conversationSnapshots[2].measurement.epoch
      : null).not.toBe(conversationSnapshots[1]?.measurement.kind === "snapshot" ? conversationSnapshots[1].measurement.epoch : null);
    expect(usage.some((observation) => observation.measurement.source.startsWith("event_msg"))).toBe(false);
  });

  it("does not suppress a projection that repeats a raw total after compaction", async () => {
    records.splice(15, 0, {
      timestamp: "2026-09-11T10:00:00Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: usage(10, 4) } },
      ordinal: 15,
    });
    writeFileSync(filePath, renderCodexRollout(records), "utf8");

    const { observations } = await collect(source);
    const projected = observations.find(
      (observation) => observation.kind === "usage" && observation.measurement.source === "event_msg.token_count.info.total_token_usage",
    );

    expect(projected).toMatchObject({ kind: "usage", measurement: { kind: "snapshot", scope: "conversation", model: null } });
  });

  it("attributes late usage by its exact turn context after the turn closes", async () => {
    const late = structuredClone(records[15]!) as { ordinal: number; payload: Record<string, unknown> };
    late.ordinal = 18;
    late.payload.response_id = "response-late";
    records.splice(18, 0, late);
    writeFileSync(filePath, renderCodexRollout(records), "utf8");

    const { observations } = await collect(source);
    const usage = observations.find(
      (observation) => observation.kind === "usage" && observation.measurement.kind === "delta" && observation.measurement.responseId === "response-late",
    );

    expect(usage).toMatchObject({
      measurement: { model: "gpt-test" },
      turn: { nativeId: CODEX_TURN },
    });
  });

  it("gives each semantic event on a usage line its own subrecord identity", async () => {
    const { observations } = await collect(source);
    const usageOffset = codexOffsetAfter(records, 11);
    const siblings = observations.filter((observation) => observation.evidence.line.byteOffset === usageOffset);

    expect(siblings.map((observation) => observation.kind)).toEqual(["usage", "usage", "usage"]);
    expect(siblings.map((observation) => observation.id.subrecordIndex)).toEqual([0, 1, 2]);
  });

  it("converges across a chunk ending between a projection and canonical message", async () => {
    const split = codexOffsetAfter(records, 4);
    const full = await collect(source);
    const first = await collect(source, { untilByteOffset: split });
    const second = await collect(source, { from: first.done.resumeBoundary });

    expect(first.done.resumeBoundary.byteOffset).toBe(codexOffsetAfter(records, 3));
    expect(second.done.restartedFromZero).toBe(false);
    expect(sortedById([...first.observations, ...second.observations])).toEqual(sortedById(full.observations));
  });

  it("withholds an incomplete final record and reads it after completion", async () => {
    const future = records.at(-1)!;
    writeFileSync(filePath, `${renderCodexRollout(records.slice(0, -1))}${JSON.stringify(future)}`, "utf8");
    const first = await collect(source);
    expect(first.observations.some((observation) => observation.kind === "unknown" && observation.nativeKind === "future_envelope")).toBe(false);

    appendFileSync(filePath, "\n", "utf8");
    const second = await collect(source, { from: first.done.resumeBoundary });
    expect(second.observations).toContainEqual(expect.objectContaining({ kind: "unknown", nativeKind: "future_envelope" }));
  });

  it("restarts from zero when bytes before the boundary are rewritten", async () => {
    const first = await collect(source, { untilByteOffset: codexOffsetAfter(records, 8) });
    const metadata = records[0] as { payload: Record<string, unknown> };
    metadata.payload.cwd = "/tmp/demo-b";
    writeFileSync(filePath, renderCodexRollout(records), "utf8");

    const resumed = await collect(source, { from: first.done.resumeBoundary });

    expect(resumed.done).toMatchObject({ restartedFromZero: true, startByteOffset: 0 });
    expect(resumed.observations[0]).toMatchObject({ kind: "metadata", entries: expect.arrayContaining([expect.objectContaining({ name: "cwd", value: "/tmp/demo-b" })]) });
  });

  it("rejects malformed completed records with byte provenance", async () => {
    appendFileSync(filePath, "not-json\n", "utf8");
    await expect(collect(source)).rejects.toBeInstanceOf(TranscriptParseError);
  });

  it("stops decoding when a consumer returns before requesting the next line", async () => {
    writeFileSync(filePath, `${JSON.stringify(records[0])}\nnot-json\n`, "utf8");
    const iterator = readCodexObservations(source);

    const first = await iterator.next();
    expect(first.value).toMatchObject({ kind: "metadata" });
    await expect(iterator.return(undefined)).resolves.toMatchObject({ done: true });
  });
});

describe("readCodexText", () => {
  it("reads selected Unicode message and tool fields without returning the JSON line", async () => {
    const { observations } = await collect(source);
    const message = observations.find(
      (observation): observation is NormalizedMessageObservation => observation.kind === "message" && observation.role === "user",
    );
    const call = observations.find(
      (observation): observation is NormalizedToolCallObservation => observation.kind === "tool_call" && observation.call.nativeId === "call-1",
    );

    expect(await readCodexText(message!.content[0]!.locator)).toBe("héllo 🌍");
    expect(await new CodexRolloutDecoder().readText(message!.content[0]!.locator)).toBe("héllo 🌍");
    expect(await readCodexText(call!.inputLocator!)).toBe("/tmp/é.txt");
    expect(message!.evidence.line.byteLength).toBe(Buffer.byteLength(JSON.stringify(records[4]), "utf8"));
    expect(message!.evidence.line.byteLength).toBeGreaterThan(JSON.stringify(records[4]).length);
  });

  it("keeps typed tool-output decoding, index projection, and locator readback in parity", async () => {
    const { observations } = await collect(source);
    const result = observations.find(
      (observation) => observation.kind === "tool_result" && observation.call.nativeId === "call-1",
    );
    if (!result || result.kind !== "tool_result" || !result.outputLocator) throw new Error("missing typed tool result");

    const indexed = normalizedSearchText(result.output);
    expect(indexed).toBe(
      "Script completed\nWall time 0.1 seconds\nOutput:\n\ncat: missing-fixture.txt: No such file or directory\nproofmarker\n",
    );
    expect(indexed).not.toContain("input_text");
    await expect(readCodexText(result.outputLocator)).resolves.toBe(indexed);
  });

  it("returns null when the selected source line has been rewritten", async () => {
    const { observations } = await collect(source);
    const message = observations.find(
      (observation): observation is NormalizedMessageObservation => observation.kind === "message" && observation.role === "user",
    );
    const response = (records[4] as { payload: { content: { text: string }[] } }).payload;
    response.content[0]!.text = "héllo 🌎";
    writeFileSync(filePath, renderCodexRollout(records), "utf8");

    await expect(readCodexText(message!.content[0]!.locator)).resolves.toBeNull();
  });

  it("resolves a moved source by stable sourceId and rejects identity mismatches", async () => {
    const { observations } = await collect(source);
    const message = observations.find((observation): observation is NormalizedMessageObservation => observation.kind === "message");
    const locator = message!.content[0]!.locator;
    const moved = path.join(dir, "archived_sessions", path.basename(filePath));
    mkdirSync(path.dirname(moved), { recursive: true });
    writeFileSync(moved, renderCodexRollout(records), "utf8");
    rmSync(filePath);
    const movedSource = (await codexSourceFromPath(moved, "host-a"))!;

    expect(await readCodexText(locator)).toBeNull();
    expect(await readCodexText(locator, { sources: [movedSource] })).toBe("héllo 🌍");
    expect(await readCodexText(locator, { sources: [{ ...movedSource, conversation: { ...movedSource.conversation, nativeId: "other" } }] })).toBeNull();
  });
});

describe("normalizedSearchText", () => {
  it("projects object string leaves without field names and enforces the span cap", () => {
    const text = normalizedSearchText({ path: "/tmp/é.txt", nested: ["result", "x".repeat(SPAN_TEXT_CAP)] });

    expect(text.startsWith("/tmp/é.txt\nresult\n")).toBe(true);
    expect(text).not.toContain("nested");
    expect(text).toHaveLength(SPAN_TEXT_CAP);
  });
});

async function collect(input: SessionSourceDescriptor, options: ReadCodexOptions = {}) {
  const observations: NormalizedSessionObservation[] = [];
  let done: CodexReadResult | undefined;
  for await (const observation of readCodexObservations(input, options, (result) => (done = result))) observations.push(observation);
  if (!done) throw new Error("reader did not report its resume boundary");
  return { observations, done };
}

function sortedById(observations: readonly NormalizedSessionObservation[]): string[] {
  const unique = new Map<string, NormalizedSessionObservation>();
  for (const observation of observations) unique.set(JSON.stringify(observation.id), observation);
  return [...unique.values()].map((observation) => JSON.stringify(observation)).sort();
}

function usage(input: number, output: number) {
  return {
    input_tokens: input,
    cached_input_tokens: Math.floor(input / 2),
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: Math.floor(output / 2),
    total_tokens: input + output,
  };
}

it("rejects invalid-byte rewrites even when lossy UTF-8 would preserve displayed text", async () => {
  records.push({ type: "response_item", payload: { type: "message", role: "assistant",
    content: [{ type: "output_text", text: "replacement �" }] } });
  const original = Buffer.from(renderCodexRollout(records));
  writeFileSync(filePath, original);
  const { observations } = await collect(source);
  const message = observations.find((observation): observation is NormalizedMessageObservation =>
    observation.kind === "message" && observation.content.some(part => part.text === "replacement �"))!;
  const locator = message.content[0]!.locator;
  expect(await readCodexText(locator)).toBe("replacement �");
  const corrupted = Buffer.from(original);
  corrupted.set([0xf0, 0x90, 0x80], corrupted.indexOf(Buffer.from("�")));
  expect(corrupted.toString("utf8")).toBe(original.toString("utf8"));
  writeFileSync(filePath, corrupted);
  expect(await readCodexText(locator)).toBeNull();
  await expect(collect(source)).rejects.toThrow();
});
