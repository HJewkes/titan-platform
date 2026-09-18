import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationIdentity } from "@titan-design/agent-protocol";
import { CLAUDE_TRANSCRIPT_FORMAT, claudeSourceFromPath, claudeSourceId } from "./claude-source.js";
import { CODEX_ROLLOUT_FORMAT, codexSourceId } from "./codex-discover.js";
import { codexFixtureRecords, renderCodexRollout } from "./codex-fixture.js";
import type { SessionSourceDescriptor } from "./normalized.js";
import { readRecentSessionTurns, readRecentSessionTurnsSync } from "./recent-session-turns.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("readRecentSessionTurns", () => {
  it("renders Claude messages and tool activity with observed metadata", async () => {
    const conversation = identity("claude-code", "claude-session");
    const rows = [
      claudeRow("user", "hello", { gitBranch: "feat/recent", isSidechain: false }),
      claudeRow("assistant", [
        { type: "thinking", thinking: "four" },
        { type: "tool_use", name: "Bash", input: { command: "pwd" } },
      ], { message: { model: "claude-test" }, isSidechain: true }),
      claudeRow("user", [{ type: "tool_result", is_error: true, content: "permission denied" }]),
      { type: "system", timestamp: "2026-09-11T10:00:03Z", content: "compacted context" },
    ];
    const source = await writeClaude(conversation, rows);
    const result = await readRecentSessionTurns(source, options());

    expect(result.status).toBe("read");
    expect(result.model).toMatchObject({ status: "observed", value: "claude-test" });
    expect(result.branch).toMatchObject({ status: "observed", value: "feat/recent" });
    expect(result.turns.map((turn) => [turn.role, turn.kind, turn.text, turn.sidechain])).toEqual([
      ["user", "message", "hello", false],
      ["assistant", "tool_call", '[thinking, 4 chars]\n[tool Bash] {"command":"pwd"}', true],
      ["user", "tool_result", "[tool result, error] permission denied", null],
      ["system", "message", "compacted context", null],
    ]);
    expect(result.unknown).toContainEqual(expect.objectContaining({ field: "sidechain", reason: "not_reported" }));
  });

  it("uses one byte as boundary evidence and preserves a record beginning exactly after it", async () => {
    const conversation = identity("claude-code", "boundary-session");
    const first = JSON.stringify(claudeRow("user", "old"));
    const second = JSON.stringify(claudeRow("assistant", "new", { message: { model: "m" } }));
    const source = await writeClaudeText(conversation, `${first}\n${second}\n`);
    const maxBytes = Buffer.byteLength(second, "utf8") + 2;
    const result = await readRecentSessionTurns(source, options({ maxBytes }));

    expect(result.bytesRead).toBe(maxBytes);
    expect(result.truncatedBefore).toBe(true);
    expect(result.turns.map((turn) => turn.text)).toEqual(["new"]);
    expect(result.turns[0]?.evidence.byteOffset).toBe(Buffer.byteLength(first, "utf8") + 1);
  });

  it("separates turn limiting from byte truncation and truncates by Unicode code point", async () => {
    const conversation = identity("claude-code", "limit-session");
    const source = await writeClaude(conversation, [claudeRow("user", "old"), claudeRow("assistant", "🌍abc")]);
    const result = await readRecentSessionTurns(source, options({ maxTurns: 1, maxCharsPerTurn: 3 }));

    expect(result.truncatedBefore).toBe(false);
    expect(result.truncatedTurns).toBe(true);
    expect(result.turns.map((turn) => turn.text)).toEqual(["🌍a…"]);
    expect(Array.from(result.turns[0]?.text ?? "")).toHaveLength(3);
  });

  it("ignores an incomplete live final record and reports the omitted suffix", async () => {
    const conversation = identity("claude-code", "partial-session");
    const complete = JSON.stringify(claudeRow("user", "complete"));
    const source = await writeClaudeText(conversation, `${complete}\n{"type":"assistant"`);
    const result = await readRecentSessionTurns(source, options());

    expect(result.turns.map((turn) => turn.text)).toEqual(["complete"]);
    expect(result.truncatedAfter).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("continues after malformed complete records and makes the error visible", async () => {
    const conversation = identity("claude-code", "malformed-session");
    const good = JSON.stringify(claudeRow("user", "still readable"));
    const source = await writeClaudeText(conversation, `{bad json}\n${good}\n`);
    const result = await readRecentSessionTurns(source, options());

    expect(result.turns.map((turn) => turn.text)).toEqual(["still readable"]);
    expect(result.errors).toEqual([
      expect.objectContaining({ kind: "malformed_record", evidence: expect.objectContaining({ byteOffset: 0 }) }),
    ]);
  });

  it("observes Claude model metadata on an assistant row without displayable text", async () => {
    const conversation = identity("claude-code", "model-only-session");
    const source = await writeClaude(conversation, [claudeRow("assistant", [], { message: { model: "observed-only" } })]);
    const result = await readRecentSessionTurns(source, options());

    expect(result.turns).toEqual([]);
    expect(result.model).toMatchObject({ status: "observed", value: "observed-only" });
  });

  it("reports invalid UTF-8 in a complete line instead of decoding replacement text", async () => {
    const conversation = identity("claude-code", "utf8-session");
    const directory = await temporaryDirectory();
    const path = join(directory, `${conversation.nativeId}.jsonl`);
    await writeFile(path, Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
    const result = await readRecentSessionTurns(claudeSource(path, conversation), options());

    expect(result.turns).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ kind: "invalid_utf8" })]);
    expect(result.model).toEqual({ status: "unknown", reason: "malformed_records" });
  });

  it("discards a leading record fragment cut inside a multibyte code point", async () => {
    const conversation = identity("claude-code", "split-utf8-session");
    const first = JSON.stringify(claudeRow("user", "prefix 🌍"));
    const second = JSON.stringify(claudeRow("assistant", "intact 🌲"));
    const value = `${first}\n${second}\n`;
    const splitAt = Buffer.from(value).indexOf(Buffer.from("🌍")) + 1;
    const source = await writeClaudeText(conversation, value);
    const result = await readRecentSessionTurns(source, options({ maxBytes: Buffer.byteLength(value) - splitAt }));

    expect(result.truncatedBefore).toBe(true);
    expect(result.turns.map((turn) => turn.text)).toEqual(["intact 🌲"]);
    expect(result.errors).toEqual([]);
  });

  it("does not silently strip a UTF-8 BOM from the hashed record", async () => {
    const conversation = identity("claude-code", "bom-session");
    const directory = await temporaryDirectory();
    const path = join(directory, `${conversation.nativeId}.jsonl`);
    const row = Buffer.from(`${JSON.stringify(claudeRow("user", "hello"))}\n`);
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), row]));
    const result = await readRecentSessionTurns(claudeSource(path, conversation), options());

    expect(result.turns).toEqual([]);
    expect(result.errors).toEqual([expect.objectContaining({ kind: "malformed_record" })]);
    expect(result.errors[0]?.evidence?.byteLength).toBe(row.length - 1 + 3);
  });

  it("prefers Codex canonical messages and keeps unmatched projections", async () => {
    const conversation = identity("codex", "child-thread");
    const source = await writeCodex(conversation, codexFixtureRecords());
    const result = await readRecentSessionTurns(source, options({ maxBytes: 1024 * 1024 }));

    const messages = result.turns.filter((turn) => turn.kind === "message");
    expect(messages.map((turn) => [turn.text, turn.representation])).toEqual([
      ["héllo 🌍", "canonical"],
      ["Working.", "canonical"],
      ["Projection-only completion.", "projection-fallback"],
    ]);
    expect(result.turns.some((turn) => turn.kind === "tool_call" && turn.text.includes("functions.run"))).toBe(true);
    expect(result.turns.some((turn) => turn.kind === "tool_result" && turn.text.includes("proofmarker"))).toBe(true);
    expect(result.model).toMatchObject({ status: "observed", value: "gpt-test" });
  });

  it("deduplicates projections only within the same bounded task segment", async () => {
    const conversation = identity("codex", "segments-thread");
    const records = [
      codexEnvelope("event_msg", { type: "task_started" }),
      codexEnvelope("event_msg", { type: "agent_message", message: "same" }),
      codexEnvelope("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "same" }] }),
      codexEnvelope("event_msg", { type: "task_complete" }),
      codexEnvelope("event_msg", { type: "task_started" }),
      codexEnvelope("event_msg", { type: "agent_message", message: "same" }),
    ];
    const result = await readRecentSessionTurns(await writeCodex(conversation, records), options());

    expect(result.turns.map((turn) => turn.representation)).toEqual(["canonical", "projection-fallback"]);
  });

  it("marks context outside a Codex byte window and missing tool error state as unknown", async () => {
    const conversation = identity("codex", "bounded-thread");
    const prefix = renderCodexRollout([
      codexEnvelope("turn_context", { model: "outside-model" }),
      codexEnvelope("event_msg", { type: "task_started" }),
    ]);
    const resultRecord = JSON.stringify(codexEnvelope("response_item", { type: "function_call_output", output: "ok" }));
    const source = await writeCodexText(conversation, `${prefix}${resultRecord}\n`);
    const result = await readRecentSessionTurns(source, options({ maxBytes: Buffer.byteLength(resultRecord) + 2 }));

    expect(result.model).toEqual({ status: "unknown", reason: "outside_window" });
    expect(result.turns).toEqual([expect.objectContaining({ kind: "tool_result", toolResultError: null })]);
    expect(result.unknown).toContainEqual(expect.objectContaining({ field: "tool_result_error", reason: "not_reported" }));
    expect(result.unknown).toContainEqual(expect.objectContaining({ field: "sidechain", reason: "unsupported_by_format" }));
  });

  it("returns an explicit unavailable result when the source disappears", async () => {
    const conversation = identity("claude-code", "missing-session");
    const directory = await temporaryDirectory();
    const source = claudeSource(join(directory, `${conversation.nativeId}.jsonl`), conversation);
    const result = await readRecentSessionTurns(source, options());

    expect(result).toMatchObject({
      status: "unavailable",
      turns: [],
      model: { status: "unknown", reason: "source_unavailable" },
      errors: [{ kind: "io" }],
    });
  });

  it("offers the same parsing through the synchronous compatibility transport", async () => {
    const conversation = identity("claude-code", "sync-session");
    const source = await writeClaude(conversation, [claudeRow("user", "hello"), claudeRow("assistant", "done")]);
    const asynchronous = await readRecentSessionTurns(source, options());
    expect(readRecentSessionTurnsSync(source, options())).toEqual(asynchronous);
  });

  it.each([0, Number.NaN, 1.5])("rejects malformed bounds before reading: %s", async (value) => {
    const conversation = identity("claude-code", "invalid-bound-session");
    const directory = await temporaryDirectory();
    const source = claudeSource(join(directory, `${conversation.nativeId}.jsonl`), conversation);
    await expect(readRecentSessionTurns(source, options({ maxBytes: value }))).rejects.toThrow(/maxBytes/);
  });

  it("rejects a mismatched descriptor before reading its path", async () => {
    const conversation = identity("codex", "wrong-thread");
    const source = { ...codexSource("/does/not/exist.jsonl", conversation), harness: "claude-code" };
    await expect(readRecentSessionTurns(source, options())).rejects.toThrow(/consistent codex-rollout/);
  });

  it("rejects a Claude native session mismatch observed inside the window", async () => {
    const conversation = identity("claude-code", "expected-session");
    const source = await writeClaude(conversation, [claudeRow("user", "wrong", { sessionId: "other-session" })]);
    await expect(readRecentSessionTurns(source, options())).rejects.toThrow(/other-session, expected expected-session/);
  });

  it("rejects multiple parent session IDs in one Claude sidechain window", async () => {
    const conversation = identity("claude-code", "child-agent");
    const directory = await temporaryDirectory();
    const path = join(directory, `agent-${conversation.nativeId}.jsonl`);
    const rows = [
      claudeRow("user", "one", { sessionId: "parent-one" }),
      claudeRow("assistant", "two", { sessionId: "parent-two" }),
    ];
    await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    await expect(readRecentSessionTurns(claudeSource(path, conversation), options())).rejects.toThrow(/multiple parent sessions/);
  });

  it("rejects a Codex native thread mismatch observed inside the window", async () => {
    const conversation = identity("codex", "expected-thread");
    const source = await writeCodex(conversation, [codexEnvelope("session_meta", { id: "other-thread" })]);
    await expect(readRecentSessionTurns(source, options())).rejects.toThrow(/other-thread, expected expected-thread/);
  });
});

describe("readRecentSessionTurns with the text projection", () => {
  it("returns the last spoken turns, counting only after tool activity and thinking are dropped", async () => {
    const conversation = identity("claude-code", "spoken-session");
    const rows = [
      claudeRow("user", "fix the build"),
      claudeRow("assistant", [{ type: "thinking", thinking: "plan" }]),
      claudeRow("assistant", [
        { type: "text", text: "Reading the failing test now." },
        { type: "tool_use", name: "Bash", input: { command: "npm test" } },
      ]),
      claudeRow("user", [{ type: "tool_result", is_error: true, content: "1 failed" }]),
      claudeRow("assistant", [{ type: "tool_use", name: "Edit", input: {} }]),
      { type: "system", timestamp: "2026-09-11T10:00:03Z", content: "compacted context" },
      claudeRow("assistant", [{ type: "text", text: "Fixed; the suite passes." }]),
    ];
    const source = await writeClaude(conversation, rows);

    const result = await readRecentSessionTurns(source, options({ maxTurns: 2, projection: "text" }));

    expect(result.turns.map((turn) => [turn.role, turn.kind, turn.text])).toEqual([
      ["assistant", "message", "Reading the failing test now."],
      ["assistant", "message", "Fixed; the suite passes."],
    ]);
    expect(result.truncatedTurns).toBe(true);
  });

  it("returns every spoken turn without claiming truncation when fewer exist than requested", async () => {
    const conversation = identity("claude-code", "short-session");
    const source = await writeClaude(conversation, [claudeRow("user", "hi"), claudeRow("assistant", [{ type: "text", text: "hello" }])]);

    const result = await readRecentSessionTurns(source, options({ maxTurns: 20, projection: "text" }));

    expect(result.turns.map((turn) => turn.text)).toEqual(["hi", "hello"]);
    expect(result.truncatedTurns).toBe(false);
  });

  it("reads an empty transcript as no turns and an unreported model", async () => {
    const conversation = identity("claude-code", "empty-session");
    const source = await writeClaudeText(conversation, "");

    const result = await readRecentSessionTurns(source, options({ projection: "text" }));

    expect(result).toMatchObject({ status: "read", turns: [], bytesRead: 0, truncatedAfter: false, errors: [] });
    expect(result.model).toEqual({ status: "unknown", reason: "not_reported" });
  });

  it("keeps the last complete spoken turn while the next record is still being written", async () => {
    const conversation = identity("claude-code", "live-session");
    const complete = JSON.stringify(claudeRow("assistant", [{ type: "text", text: "halfway there" }]));
    const source = await writeClaudeText(conversation, `${complete}\n{"type":"assistant","message":{"content":[{"type":"te`);

    const result = await readRecentSessionTurns(source, options({ projection: "text" }));

    expect(result.turns.map((turn) => turn.text)).toEqual(["halfway there"]);
    expect(result.truncatedAfter).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("marks a subagent's spoken turns as sidechain in a transcript addressed by path", async () => {
    const parent = "parent-session";
    const directory = await temporaryDirectory();
    const path = join(directory, "agent-child.jsonl");
    const rows = [claudeRow("assistant", [{ type: "text", text: "child report" }], { sessionId: parent, isSidechain: true })];
    await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

    const result = await readRecentSessionTurns(claudeSourceFromPath(path, "test-host"), options({ projection: "text" }));

    expect(result.turns.map((turn) => [turn.text, turn.sidechain])).toEqual([["child report", true]]);
  });

  it("reads only the byte window from a multi-megabyte transcript", async () => {
    const conversation = identity("claude-code", "large-session");
    const filler = JSON.stringify(claudeRow("user", [{ type: "tool_result", content: "x".repeat(64 * 1024) }]));
    const recent = [claudeRow("user", "status?"), claudeRow("assistant", [{ type: "text", text: "nearly done" }])];
    const prefix = `${filler}\n`.repeat(64);
    const source = await writeClaudeText(conversation, `${prefix}${recent.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const maxBytes = 16 * 1024;

    const result = await readRecentSessionTurns(source, options({ maxBytes, projection: "text" }));

    expect(Buffer.byteLength(prefix)).toBeGreaterThan(4 * 1024 * 1024);
    expect(result.bytesRead).toBe(maxBytes);
    expect(result.truncatedBefore).toBe(true);
    expect(result.turns.map((turn) => turn.text)).toEqual(["status?", "nearly done"]);
  });

  it("keeps only Codex messages", async () => {
    const conversation = identity("codex", "child-thread");
    const source = await writeCodex(conversation, codexFixtureRecords());

    const result = await readRecentSessionTurns(source, options({ maxBytes: 1024 * 1024, projection: "text" }));

    expect(result.turns.length).toBeGreaterThan(0);
    expect(result.turns.every((turn) => turn.kind === "message")).toBe(true);
  });

  it("rejects an unknown projection before reading", async () => {
    const conversation = identity("claude-code", "bad-projection");
    const source = claudeSource("/does/not/exist.jsonl", conversation);
    const projection = "spoken" as unknown as "text";

    await expect(readRecentSessionTurns(source, options({ projection }))).rejects.toThrow(/projection must be one of/);
  });
});

describe("readRecentSessionTurns model observation", () => {
  it("ignores the placeholder model Claude Code writes on locally generated error rows", async () => {
    const conversation = identity("claude-code", "synthetic-session");
    const rows = [
      claudeRow("assistant", [{ type: "text", text: "working" }], { message: { model: "claude-opus-5" } }),
      claudeRow("assistant", [{ type: "text", text: "API Error: request aborted" }], {
        message: { model: "<synthetic>" },
        isApiErrorMessage: true,
      }),
    ];
    const source = await writeClaude(conversation, rows);

    const result = await readRecentSessionTurns(source, options());

    expect(result.model).toMatchObject({ status: "observed", value: "claude-opus-5" });
  });
});

function options(overrides: Partial<Parameters<typeof readRecentSessionTurns>[1]> = {}) {
  return { maxBytes: 64 * 1024, maxTurns: 20, maxCharsPerTurn: 700, ...overrides };
}

function identity(harness: string, nativeId: string): ConversationIdentity {
  return { harness, namespace: "test-host", nativeId };
}

function claudeRow(type: "user" | "assistant", content: unknown, extra: Record<string, unknown> = {}) {
  const message = { ...(typeof extra.message === "object" ? extra.message : {}), content };
  const rowExtra = Object.fromEntries(Object.entries(extra).filter(([name]) => name !== "message"));
  return { type, timestamp: "2026-09-11T10:00:00Z", ...rowExtra, message };
}

async function writeClaude(conversation: ConversationIdentity, rows: readonly unknown[]) {
  return writeClaudeText(conversation, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

async function writeClaudeText(conversation: ConversationIdentity, value: string) {
  const directory = await temporaryDirectory();
  const path = join(directory, `${conversation.nativeId}.jsonl`);
  await writeFile(path, value);
  return claudeSource(path, conversation);
}

function claudeSource(path: string, conversation: ConversationIdentity): SessionSourceDescriptor {
  return {
    sourceId: claudeSourceId(conversation.namespace, conversation.nativeId),
    harness: "claude-code",
    format: CLAUDE_TRANSCRIPT_FORMAT,
    formatVersion: null,
    path,
    namespace: conversation.namespace,
    conversation,
    provenance: { kind: "claude-code-transcript", legacySessionId: conversation.nativeId },
  };
}

async function writeCodex(conversation: ConversationIdentity, records: readonly Record<string, unknown>[]) {
  return writeCodexText(conversation, renderCodexRollout(records));
}

async function writeCodexText(conversation: ConversationIdentity, value: string) {
  const directory = await temporaryDirectory();
  const path = join(directory, "rollout.jsonl");
  await writeFile(path, value);
  return codexSource(path, conversation);
}

function codexSource(path: string, conversation: ConversationIdentity): SessionSourceDescriptor {
  return {
    sourceId: codexSourceId(conversation.namespace, conversation.nativeId, "rollout-test"),
    harness: "codex",
    format: CODEX_ROLLOUT_FORMAT,
    formatVersion: null,
    path,
    namespace: conversation.namespace,
    conversation,
    provenance: { kind: "codex-rollout", sessionTreeId: null, historyMode: "unknown" },
  };
}

function codexEnvelope(type: string, payload: Record<string, unknown>): Record<string, unknown> {
  return { timestamp: "2026-09-11T10:00:00Z", type, payload };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "titan-recent-session-"));
  directories.push(directory);
  return directory;
}
