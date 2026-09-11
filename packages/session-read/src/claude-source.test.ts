import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationIdentity } from "@titan-design/agent-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertClaudeSessionSource,
  claudeProjectSlug,
  claudeSourceId,
  CLAUDE_TRANSCRIPT_FORMAT,
  findClaudeSessionSource,
} from "./claude-source.js";

const conversation: ConversationIdentity = { harness: "claude-code", namespace: "host-a", nativeId: "session-1" };
let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "titan-claude-source-"));
  cwd = path.join(root, "repo");
  mkdirSync(cwd);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("findClaudeSessionSource", () => {
  it("finds and qualifies an exact transcript after checking its native identity", () => {
    const filePath = writeTranscript(claudeProjectSlug(cwd), conversation.nativeId);

    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toEqual({
      status: "found",
      source: {
        sourceId: claudeSourceId("host-a", "session-1"),
        harness: "claude-code",
        format: CLAUDE_TRANSCRIPT_FORMAT,
        formatVersion: null,
        path: filePath,
        namespace: "host-a",
        conversation,
        provenance: { kind: "claude-code-transcript", legacySessionId: "session-1" },
      },
    });
  });

  it("scans other project slugs without accepting a mismatched transcript", () => {
    writeTranscript("old-project", "different-session", conversation.nativeId);
    const matching = writeTranscript("moved-project", conversation.nativeId);

    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toEqual({
      status: "found",
      source: expect.objectContaining({ path: matching }),
    });
  });

  it("distinguishes a missing or empty source from an unsafe identity mismatch", () => {
    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toMatchObject({ status: "not_written" });
    writeTranscript(claudeProjectSlug(cwd), null);
    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toMatchObject({ status: "not_written" });

    writeTranscript(claudeProjectSlug(cwd), "other-session", conversation.nativeId);
    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("contains session other-session"),
    });
  });

  it("treats a partial first record as not written and complete records without identity as unavailable", () => {
    const filePath = writeTranscript(claudeProjectSlug(cwd), null);
    writeFileSync(filePath, '{"type":"file-history-snapshot"', "utf8");
    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toMatchObject({ status: "not_written" });

    const completeWithoutIdentity = `${JSON.stringify({ type: "file-history-snapshot", padding: "x".repeat(96) })}\n`;
    writeFileSync(filePath, completeWithoutIdentity.repeat(3_000), "utf8");
    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("no native session identity within the bounded probe"),
    });
  });

  for (const nativeId of ["../session-1", "nested/session-1", "nested\\session-1", ".", ".."]) {
    it(`rejects native ID ${nativeId} before constructing a path`, () => {
      expect(findClaudeSessionSource({ cwd, conversation: { ...conversation, nativeId }, configDir: root })).toMatchObject({
        status: "unavailable",
      });
    });
  }
});

describe("assertClaudeSessionSource", () => {
  it("rejects mismatched filenames, IDs, namespaces, provenance, and extensions", () => {
    const result = findClaudeSessionSource({ cwd, conversation, configDir: root });
    expect(result.status).toBe("not_written");
    const valid = {
      sourceId: claudeSourceId("host-a", "session-1"),
      harness: "claude-code",
      format: CLAUDE_TRANSCRIPT_FORMAT,
      formatVersion: null,
      path: path.join(root, "session-1.jsonl"),
      namespace: "host-a",
      conversation,
      provenance: { kind: "claude-code-transcript" as const, legacySessionId: "session-1" },
    };
    expect(() => assertClaudeSessionSource(valid)).not.toThrow();
    expect(() => assertClaudeSessionSource({ ...valid, path: path.join(root, "other.jsonl") })).toThrow(/filename/);
    expect(() => assertClaudeSessionSource({ ...valid, path: path.join(root, "session-1.txt") })).toThrow(/extension/);
    expect(() => assertClaudeSessionSource({ ...valid, sourceId: "collision" })).toThrow(/source ID/);
    expect(() => assertClaudeSessionSource({ ...valid, namespace: "host-b" })).toThrow(/namespace/);
    expect(() => assertClaudeSessionSource({ ...valid, provenance: { ...valid.provenance, legacySessionId: "other" } })).toThrow(/provenance/);
  });
});

function writeTranscript(projectSlug: string, recordSessionId: string | null, filenameSessionId = conversation.nativeId): string {
  const filePath = path.join(root, "projects", projectSlug, `${filenameSessionId}.jsonl`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const text = recordSessionId === null ? "" : `${JSON.stringify({ type: "user", sessionId: recordSessionId })}\n`;
  writeFileSync(filePath, text, "utf8");
  return filePath;
}
