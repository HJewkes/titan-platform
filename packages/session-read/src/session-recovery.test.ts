import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeSourceFromPath } from "./claude-source.js";
import { LONG_REPLY, RECOVERY_ROOT, RECOVERY_SESSION, SECRET_ARG, recoveryTranscript } from "./recovery-fixture.js";
import { RECOVERY_LIST_CAP, RECOVERY_MESSAGE_CHARS, RecoveryFacts, recoverSession } from "./session-recovery.js";
import type { SessionRecovery } from "./session-recovery.js";
import type { NormalizedSessionObservation, NormalizedToolCallObservation } from "./normalized.js";

let dir: string;
let recovery: SessionRecovery;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "session-recovery-"));
  const path = join(dir, `${RECOVERY_SESSION}.jsonl`);
  await writeFile(path, recoveryTranscript());
  recovery = await recoverSession(claudeSourceFromPath(path, "test"), { root: RECOVERY_ROOT });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe("recovering an unwrapped operator session from facts", () => {
  it("reports the session span and the registered agent name", () => {
    expect(recovery.startedAt).toBe("2026-03-04T09:00:00Z");
    expect(recovery.endedAt).toBe("2026-03-04T09:18:00Z");
    expect(recovery.agentName).toBe("ops-lead");
  });

  it("lists only files written under the root, relative to it", () => {
    expect(recovery.filesWritten).toEqual({ items: ["notes/handoff.md"], dropped: 0 });
  });

  it("counts active-work calls by head and subcommand without argument text", () => {
    expect(recovery.activeWorkCalls.items).toEqual([
      { head: "active-work task add", count: 1, lastAt: "2026-03-04T09:03:00Z" },
      { head: "active-work task done", count: 2, lastAt: "2026-03-04T09:14:00Z" },
      { head: "active-work note add", count: 1, lastAt: "2026-03-04T09:13:00Z" },
    ]);
  });

  it("keeps git and gh calls as command heads so no token or query leaks", () => {
    expect(recovery.gitCommands.items.map(entry => entry.head)).toEqual(["git status", "git log", "gh pr merge", "gh api GET pulls"]);
    expect(JSON.stringify(recovery)).not.toContain(SECRET_ARG);
    expect(JSON.stringify(recovery)).not.toContain("per_page");
  });

  it("reports chat_send and agent_spawn targets with their first non-empty line", () => {
    expect(recovery.chatSends.items).toEqual([
      { target: "demo-reviewer", firstLine: "Heads up: DM-12 is in flight.", at: "2026-03-04T09:07:00Z" }]);
    expect(recovery.agentSpawns.items).toEqual([
      { target: "dm-12-worker", firstLine: "Implement DM-12: fix the flaky parser.", at: "2026-03-04T09:06:00Z" }]);
  });

  it("keeps the last five owner messages, excluding tool results and injected blocks", () => {
    expect(recovery.ownerMessages.map(message => message.text)).toEqual([
      "Spawn a worker for DM-12 and tell the reviewer.",
      "Good. Merge it once checks pass.",
      "Also close the loop on the release note.",
      "And check the nightly run.",
      "Last thing: post the summary.",
    ]);
  });

  it("caps the last assistant message", () => {
    const text = recovery.lastAssistantMessage?.text ?? "";
    expect(LONG_REPLY.length).toBeGreaterThan(RECOVERY_MESSAGE_CHARS);
    expect(Array.from(text)).toHaveLength(RECOVERY_MESSAGE_CHARS);
    expect(text.startsWith("Merged the parser fix.")).toBe(true);
    expect(recovery.messageWindowTruncated).toBe(false);
  });
});

describe("recovering compactions", () => {
  const MARKER = "This session is being continued from a previous conversation";
  const conversation = { harness: "claude-code", namespace: "test", nativeId: "compacted" };

  function summaryRow(index: number): Record<string, unknown> {
    const ts = `2026-03-05T10:0${index}:00Z`;
    return { type: "user", uuid: `c${index}`, timestamp: ts,
      message: { role: "user", content: `${MARKER}\n\nSummary number ${index}.` } };
  }

  function boundaryRow(): Record<string, unknown> {
    return { type: "system", subtype: "compact_boundary", uuid: "b1", timestamp: "2026-03-05T10:09:00Z" };
  }

  async function recoverRows(rows: Record<string, unknown>[]): Promise<SessionRecovery> {
    const sessionId = `compacted-${randomUUID()}`;
    const path = join(dir, `${sessionId}.jsonl`);
    await writeFile(path, rows.map(row => JSON.stringify({ ...row, sessionId })).join("\n") + "\n");
    return recoverSession(claudeSourceFromPath(path, "test"), { root: RECOVERY_ROOT });
  }

  function compaction(summary: string | null, historyOrigin: typeof conversation | null): NormalizedSessionObservation {
    return { kind: "compaction", conversation, historyOrigin, timestamp: null, item: null, turn: null, encrypted: null,
      usageEpochAfter: null, ...(summary ? { nativeExtensions: [{ name: "compactionSummary", value: summary }] } : {}),
      id: { sourceId: "s", byteOffset: 0, subrecordIndex: 0 },
      evidence: { line: { sourceId: "s", byteOffset: 0, byteLength: 1, contentHash: "h", lineNumber: 1, nativeOrdinal: null },
        subrecord: { index: 0, path: [] } } };
  }

  it("reports zero compactions for a transcript that never compacted", () => {
    expect(recovery.compactions).toEqual({ count: 0, lastSummaries: [] });
  });

  it("reports one compaction with its summary", async () => {
    const result = await recoverRows([summaryRow(1)]);
    expect(result.compactions).toEqual({ count: 1, lastSummaries: ["Summary number 1."] });
  });

  it("counts four compactions but keeps only the last three summaries, oldest first", async () => {
    const result = await recoverRows([1, 2, 3, 4].map(summaryRow));
    expect(result.compactions).toEqual({ count: 4,
      lastSummaries: ["Summary number 2.", "Summary number 3.", "Summary number 4."] });
  });

  it("counts a compaction with no summary text without listing it", async () => {
    const result = await recoverRows([boundaryRow()]);
    expect(result.compactions).toEqual({ count: 1, lastSummaries: [] });
  });

  it("counts one compaction once when its boundary row is followed by its summary row", async () => {
    const result = await recoverRows([boundaryRow(), summaryRow(1)]);
    expect(result.compactions).toEqual({ count: 1, lastSummaries: ["Summary number 1."] });
  });

  it("counts a second compaction after a paired boundary and summary", async () => {
    const result = await recoverRows([boundaryRow(), summaryRow(1), boundaryRow(), summaryRow(2)]);
    expect(result.compactions).toEqual({ count: 2, lastSummaries: ["Summary number 1.", "Summary number 2."] });
  });

  it("skips compactions copied in from a parent conversation", () => {
    const facts = new RecoveryFacts(RECOVERY_ROOT);
    facts.add(compaction("Inherited summary.", { ...conversation, nativeId: "parent" }));
    facts.add(compaction("Own summary.", null));
    expect(facts.result().compactions).toEqual({ count: 1, lastSummaries: ["Own summary."] });
  });
});

describe("recovery fact caps", () => {
  const conversation = { harness: "claude-code", namespace: "test", nativeId: "capped" };
  function send(index: number): NormalizedToolCallObservation {
    return { kind: "tool_call", conversation, historyOrigin: null, timestamp: null, item: null, namespace: null,
      call: { conversation, kind: "call", nativeId: `c${index}` }, inputLocator: null,
      name: "mcp__plugin_agent-chat_agent-chat__chat_send", input: { to: `peer-${index}`, text: "ping" },
      id: { sourceId: "s", byteOffset: index, subrecordIndex: 0 },
      evidence: { line: { sourceId: "s", byteOffset: index, byteLength: 1, contentHash: "h", lineNumber: index, nativeOrdinal: null },
        subrecord: { index: 0, path: [] } } };
  }

  it("keeps the most recent sends and counts the dropped ones", () => {
    const facts = new RecoveryFacts(RECOVERY_ROOT);
    for (let index = 0; index < RECOVERY_LIST_CAP + 3; index++) facts.add(send(index));
    const { chatSends } = facts.result();
    expect(chatSends.dropped).toBe(3);
    expect(chatSends.items[0]?.target).toBe("peer-3");
  });

  it("rejects a relative root", () => {
    expect(() => new RecoveryFacts("relative/root")).toThrow(/absolute/);
  });
});
