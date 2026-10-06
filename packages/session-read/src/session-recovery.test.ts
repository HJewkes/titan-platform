import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeSourceFromPath } from "./claude-source.js";
import { LONG_REPLY, RECOVERY_ROOT, RECOVERY_SESSION, SECRET_ARG, recoveryTranscript } from "./recovery-fixture.js";
import { RECOVERY_LIST_CAP, RECOVERY_MESSAGE_CHARS, RecoveryFacts, recoverSession } from "./session-recovery.js";
import type { SessionRecovery } from "./session-recovery.js";
import type { NormalizedToolCallObservation } from "./normalized.js";

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
