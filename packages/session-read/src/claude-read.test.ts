import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeTranscriptDecoder } from "./claude-decoder.js";
import { readClaudeObservations, readClaudeText } from "./claude-read.js";
import { claudeProjectSlug, claudeSourceId, findClaudeSessionSource } from "./claude-source.js";
import type {
  NormalizedMessageObservation,
  NormalizedSessionObservation,
  NormalizedToolCallObservation,
  NormalizedToolResultObservation,
  SessionSourceDescriptor,
  SourceTextLocator,
} from "./normalized.js";
import type { ReadSessionObservationOptions, SessionObservationReadResult } from "./session-observations.js";
import { readSessionObservations, readSessionSourceText } from "./session-observations.js";
import { normalizedSearchText } from "./text.js";
import { TranscriptParseError } from "./read.js";

const SESSION = "session-1";
const NAMESPACE = "host-a";
const CWD = "/workspace/demo";
const COMPACTION_MARKER = "This session is being continued from a previous conversation";

let dir: string;
let configDir: string;
let filePath: string;
let records: Record<string, unknown>[];
let source: SessionSourceDescriptor;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "titan-claude-read-"));
  configDir = path.join(dir, ".claude");
  filePath = path.join(configDir, "projects", claudeProjectSlug(CWD), `${SESSION}.jsonl`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  records = claudeRecords();
  writeFileSync(filePath, render(records), "utf8");
  const found = findClaudeSessionSource({
    cwd: CWD,
    conversation: { harness: "claude-code", namespace: NAMESPACE, nativeId: SESSION },
    configDir,
  });
  if (found.status !== "found") throw new Error(`fixture source was not found: ${found.status}`);
  source = found.source;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readClaudeObservations", () => {
  it("normalizes Claude messages, turns, tools, usage, compaction, metadata, and native evidence", async () => {
    const { observations } = await collect(source);
    const messages = observations.filter((observation) => observation.kind === "message");
    const call = observations.find((observation): observation is NormalizedToolCallObservation => observation.kind === "tool_call");
    const result = observations.find((observation): observation is NormalizedToolResultObservation => observation.kind === "tool_result");
    const usage = observations.filter((observation) => observation.kind === "usage");
    const metadata = observations.flatMap((observation) => observation.kind === "metadata" ? observation.entries : []);

    expect(messages.map((message) => [message.role, message.content.map((part) => part.text).join("\n")])).toEqual([
      ["user", "héllo 🌍"],
      ["assistant", "Working."],
      ["assistant", "usage without cache detail"],
      ["user", `${COMPACTION_MARKER}\n\nKeep the tested facts only.`],
    ]);
    expect(call).toMatchObject({
      call: { nativeId: "tool-1", conversation: { nativeId: SESSION } },
      turn: { nativeId: "prompt-1" },
      name: "Bash",
      input: { command: "printf 'héllo'" },
    });
    expect(result).toMatchObject({
      call: { nativeId: "tool-1", conversation: { nativeId: SESSION } },
      turn: { nativeId: "prompt-1" },
      isError: true,
      nativeExtensions: expect.arrayContaining([{ name: "toolDenialKind", value: "permission-rule" }]),
    });
    expect(usage[0]).toMatchObject({
      measurement: {
        kind: "delta",
        responseId: "response-1",
        model: "claude-test",
        tokens: { input: 17, cachedInput: 5, cacheWriteInput: 2, output: 20, reasoningOutput: null, total: 37 },
      },
      response: { nativeId: "response-1" },
      turn: { nativeId: "prompt-1" },
      nativeExtensions: expect.arrayContaining([{ name: "service_tier", value: "standard" }]),
    });
    expect(usage[1]).toMatchObject({ measurement: { tokens: { input: null, cachedInput: null, cacheWriteInput: null, output: 3, total: null } } });
    expect(metadata).toEqual(expect.arrayContaining([
      { name: "git_branch", value: "feature/tp49", meaning: "normalized" },
      { name: "cli_version", value: "1.0.0-test", meaning: "normalized" },
      { name: "title", value: "Sanitized Claude session", meaning: "normalized" },
      { name: "seed_prompt", value: "build a fixture", meaning: "normalized" },
      { name: "slug", value: "calm-orchid", meaning: "native" },
      { name: "model", value: "claude-test", meaning: "normalized" },
    ]));
    expect(observations).toContainEqual(expect.objectContaining({ kind: "unknown", nativeKind: "claude.content.thinking", value: "private reasoning omitted" }));
    expect(observations).toContainEqual(expect.objectContaining({
      kind: "unknown",
      nativeKind: "claude.system.stop_hook_summary",
      value: expect.objectContaining({ subtype: "stop_hook_summary", hookCount: 2, preventedContinuation: true }),
      nativeExtensions: expect.arrayContaining([
        { name: "hookCount", value: 2 },
        { name: "preventedContinuation", value: true },
      ]),
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      kind: "compaction",
      nativeExtensions: expect.arrayContaining([{ name: "compactionSummary", value: "Keep the tested facts only." }]),
    }));
  });

  it("gives every semantic event on one source line distinct byte and subrecord evidence", async () => {
    const { observations } = await collect(source);
    const assistantOffset = offsetAfter(records, 3);
    const siblings = observations.filter((observation) => observation.evidence.line.byteOffset === assistantOffset);

    expect(siblings.map((observation) => observation.kind)).toEqual(["metadata", "message", "unknown", "tool_call", "usage"]);
    expect(siblings.map((observation) => observation.id.subrecordIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(siblings.every((observation) => observation.id.byteOffset === assistantOffset)).toBe(true);
  });

  it("converges across prefix replay and preserves Unicode byte boundaries", async () => {
    const full = await collect(source);
    const first = await collect(source, { untilByteOffset: offsetAfter(records, 4) });
    const second = await collect(source, { from: first.done.resumeBoundary });

    expect(first.done.resumeBoundary.byteOffset).toBe(offsetAfter(records, 4));
    expect(second.done.restartedFromZero).toBe(false);
    expect(sortedById([...first.observations, ...second.observations])).toEqual(sortedById(full.observations));
    const message = full.observations.find(
      (observation): observation is NormalizedMessageObservation => observation.kind === "message" && observation.role === "user",
    );
    expect(message!.evidence.line.byteLength).toBe(Buffer.byteLength(JSON.stringify(records[2]), "utf8"));
    expect(message!.evidence.line.byteLength).toBeGreaterThan(JSON.stringify(records[2]).length);
  });

  it("withholds partial tails, restarts after a prefix rewrite, and locates malformed complete lines", async () => {
    const future = records.at(-1)!;
    writeFileSync(filePath, `${render(records.slice(0, -1))}${JSON.stringify(future)}`, "utf8");
    const partial = await collect(source);
    expect(partial.observations.some((observation) => observation.kind === "unknown" && observation.nativeKind === "claude.future-event")).toBe(false);
    appendFileSync(filePath, "\n", "utf8");
    const completed = await collect(source, { from: partial.done.resumeBoundary });
    expect(completed.observations).toContainEqual(expect.objectContaining({ kind: "unknown", nativeKind: "claude.future-event" }));

    const first = await collect(source, { untilByteOffset: offsetAfter(records, 3) });
    records[0]!.aiTitle = "Rewritten title";
    writeFileSync(filePath, render(records), "utf8");
    const restarted = await collect(source, { from: first.done.resumeBoundary });
    expect(restarted.done).toMatchObject({ restartedFromZero: true, startByteOffset: 0 });

    appendFileSync(filePath, "not-json\n", "utf8");
    await expect(collect(source)).rejects.toBeInstanceOf(TranscriptParseError);
  });

  it("stops decoding when a consumer returns before requesting a malformed next line", async () => {
    writeFileSync(filePath, `${JSON.stringify(records[0])}\nnot-json\n`, "utf8");
    const iterator = readClaudeObservations(source);
    expect((await iterator.next()).value).toMatchObject({ kind: "metadata" });
    await expect(iterator.return(undefined)).resolves.toMatchObject({ done: true });
  });

  it("rejects a completed row that names another ordinary session", async () => {
    records[3]!.sessionId = "different-session";
    writeFileSync(filePath, render(records), "utf8");
    await expect(collect(source)).rejects.toThrow(/contains session different-session/);
  });

  it("scopes a subagent transcript to the child and emits its observed parent identity", async () => {
    const childId = "child-agent";
    const childPath = path.join(dir, `agent-${childId}.jsonl`);
    const childSource: SessionSourceDescriptor = {
      sourceId: claudeSourceId(NAMESPACE, childId),
      harness: "claude-code",
      format: "claude-code-jsonl",
      formatVersion: null,
      path: childPath,
      namespace: NAMESPACE,
      conversation: { harness: "claude-code", namespace: NAMESPACE, nativeId: childId },
      provenance: { kind: "claude-code-transcript", legacySessionId: childId },
    };
    writeFileSync(childPath, `${JSON.stringify({ type: "user", sessionId: SESSION, uuid: "child-prompt", message: { role: "user", content: "child work" } })}\n`, "utf8");
    const { observations } = await collect(childSource);

    expect(observations).toContainEqual(expect.objectContaining({
      kind: "lineage",
      relationship: "parent",
      conversation: expect.objectContaining({ nativeId: childId }),
      relatedConversation: { harness: "claude-code", namespace: NAMESPACE, nativeId: SESSION },
    }));
    expect(observations).toContainEqual(expect.objectContaining({
      kind: "message",
      conversation: expect.objectContaining({ nativeId: childId }),
      content: [expect.objectContaining({ text: "child work" })],
    }));
  });

  it("rejects invalid UTF-8 instead of hashing replacement characters", async () => {
    const invalid = Buffer.concat([
      Buffer.from(render(records), "utf8"),
      Buffer.from('{"type":"future-event","value":"', "utf8"),
      Buffer.from([0x80]),
      Buffer.from('"}\n', "utf8"),
    ]);
    writeFileSync(filePath, invalid);

    await expect(collect(source)).rejects.toThrow(/UTF-8/i);
  });
});

describe("Claude locator readback and dispatcher", () => {
  it("keeps decoded, indexed, direct, decoder, and generic readback text in parity", async () => {
    const { observations } = await collectWith(readSessionObservations, source);
    const result = observations.find((observation): observation is NormalizedToolResultObservation => observation.kind === "tool_result");
    if (!result?.outputLocator) throw new Error("missing tool result locator");
    const indexed = normalizedSearchText(result.output);

    expect(indexed).toBe("Permission denied by sanitized fixture.\nproofmarker");
    await expect(readClaudeText(result.outputLocator)).resolves.toBe(indexed);
    await expect(new ClaudeTranscriptDecoder().readText(result.outputLocator)).resolves.toBe(indexed);
    await expect(readSessionSourceText(result.outputLocator)).resolves.toBe(indexed);
  });

  it("resolves a moved source and rejects descriptor, row-identity, and source-hash mismatches", async () => {
    const { observations } = await collect(source);
    const result = observations.find((observation): observation is NormalizedToolResultObservation => observation.kind === "tool_result");
    const locator = result!.outputLocator!;
    const moved = path.join(configDir, "projects", "archived", `${SESSION}.jsonl`);
    mkdirSync(path.dirname(moved), { recursive: true });
    renameSync(filePath, moved);
    const movedSource = { ...source, path: moved };

    await expect(readClaudeText(locator)).resolves.toBeNull();
    await expect(readClaudeText(locator, { sources: [movedSource] })).resolves.toBe("Permission denied by sanitized fixture.\nproofmarker");
    await expect(readClaudeText(locator, { sources: [{ ...movedSource, namespace: "other" }] })).resolves.toBeNull();

    records[4]!.sessionId = "other-one";
    writeFileSync(moved, render(records), "utf8");
    const altered = JSON.stringify(records[4]);
    const forged: SourceTextLocator = {
      ...locator,
      source: movedSource,
      evidence: {
        ...locator.evidence,
        line: { ...locator.evidence.line, byteLength: Buffer.byteLength(altered), contentHash: hashLine(altered) },
      },
    };
    await expect(readClaudeText(forged, { sources: [movedSource] })).resolves.toBeNull();
    await expect(readClaudeText(locator, { sources: [movedSource] })).resolves.toBeNull();
  });

  it("returns null for unsupported format locators", async () => {
    const { observations } = await collect(source);
    const message = observations.find((observation): observation is NormalizedMessageObservation => observation.kind === "message");
    const unsupported = { ...message!.content[0]!.locator, source: { ...source, format: "future-format" } };
    await expect(readSessionSourceText(unsupported)).resolves.toBeNull();
  });

  it("rejects an equal-length invalid UTF-8 rewrite that lossy decoding would conceal", async () => {
    records[2]!.message = { role: "user", content: "replacement: �" };
    writeFileSync(filePath, render(records), "utf8");
    const { observations } = await collect(source);
    const message = observations.find(
      (observation): observation is NormalizedMessageObservation => observation.kind === "message" && observation.role === "user",
    );
    const bytes = Buffer.from(render(records), "utf8");
    const replacement = bytes.indexOf(Buffer.from("�", "utf8"));
    expect(replacement).toBeGreaterThanOrEqual(0);
    Buffer.from([0xf0, 0x90, 0x80]).copy(bytes, replacement);
    writeFileSync(filePath, bytes);

    await expect(readClaudeText(message!.content[0]!.locator)).resolves.toBeNull();
  });
});

async function collect(input: SessionSourceDescriptor, options: ReadSessionObservationOptions = {}) {
  return collectWith(readClaudeObservations, input, options);
}

async function collectWith(
  reader: (
    input: SessionSourceDescriptor,
    options?: ReadSessionObservationOptions,
    onDone?: (result: SessionObservationReadResult) => void,
  ) => AsyncGenerator<NormalizedSessionObservation>,
  input: SessionSourceDescriptor,
  options: ReadSessionObservationOptions = {},
) {
  const observations: NormalizedSessionObservation[] = [];
  let done: SessionObservationReadResult | undefined;
  for await (const observation of reader(input, options, (result) => (done = result))) observations.push(observation);
  if (!done) throw new Error("reader did not report its resume boundary");
  return { observations, done };
}

function sortedById(observations: readonly NormalizedSessionObservation[]): string[] {
  const unique = new Map<string, NormalizedSessionObservation>();
  for (const observation of observations) unique.set(JSON.stringify(observation.id), observation);
  return [...unique.values()].map((observation) => JSON.stringify(observation)).sort();
}

function render(values: readonly Record<string, unknown>[]): string {
  return values.map((value) => JSON.stringify(value)).join("\n") + "\n";
}

function offsetAfter(values: readonly Record<string, unknown>[], count: number): number {
  return Buffer.byteLength(render(values.slice(0, count)), "utf8");
}

function hashLine(line: string): string {
  return createHash("sha256").update(line, "utf8").digest("hex");
}

function claudeRecords(): Record<string, unknown>[] {
  const base = { sessionId: SESSION, cwd: CWD, gitBranch: "feature/tp49", version: "1.0.0-test", slug: "calm-orchid" };
  return [
    { ...base, type: "ai-title", aiTitle: "Sanitized Claude session", timestamp: "2026-09-11T10:00:00Z" },
    { ...base, type: "last-prompt", lastPrompt: "build a fixture", timestamp: "2026-09-11T10:00:01Z" },
    { ...base, type: "user", uuid: "prompt-1", timestamp: "2026-09-11T10:00:02Z", permissionMode: "acceptEdits", message: { role: "user", content: "héllo 🌍" } },
    {
      ...base,
      type: "assistant",
      uuid: "assistant-1",
      parentUuid: "prompt-1",
      timestamp: "2026-09-11T10:00:03Z",
      message: {
        id: "response-1",
        role: "assistant",
        model: "claude-test",
        usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 20, service_tier: "standard" },
        content: [
          { type: "thinking", thinking: "private reasoning omitted", signature: "synthetic" },
          { type: "text", text: "Working." },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "printf 'héllo'" } },
        ],
      },
    },
    {
      ...base,
      type: "user",
      uuid: "result-1",
      parentUuid: "assistant-1",
      timestamp: "2026-09-11T10:00:04Z",
      toolDenialKind: "permission-rule",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true, content: [{ type: "text", text: "Permission denied by sanitized fixture." }, { type: "text", text: "proofmarker" }] }],
      },
    },
    {
      ...base,
      type: "assistant",
      uuid: "assistant-2",
      timestamp: "2026-09-11T10:00:05Z",
      message: { id: "response-2", role: "assistant", model: "claude-test", usage: { input_tokens: 4, output_tokens: 3 }, content: [{ type: "text", text: "usage without cache detail" }] },
    },
    { ...base, type: "system", subtype: "stop_hook_summary", hookCount: 2, preventedContinuation: true, hookInfos: [{ command: "synthetic-hook" }], timestamp: "2026-09-11T10:00:06Z" },
    { ...base, type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto", preTokens: 100 }, logicalParentUuid: "prompt-1", timestamp: "2026-09-11T10:00:07Z" },
    { ...base, type: "user", uuid: "prompt-2", timestamp: "2026-09-11T10:00:08Z", message: { role: "user", content: `${COMPACTION_MARKER}\n\nKeep the tested facts only.` } },
    { ...base, type: "future-event", futureValue: 42, timestamp: "2026-09-11T10:00:09Z" },
  ];
}
