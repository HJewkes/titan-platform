import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationIdentity } from "@titan-design/agent-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertClaudeSessionSource,
  claudeProjectSlug,
  claudeSourceFromPath,
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

  it("does not scan past an empty direct file", () => {
    writeTranscript(claudeProjectSlug(cwd), null);
    writeTranscript("other-project", conversation.nativeId);

    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toMatchObject({ status: "not_written" });
  });

  it("skips a non-file candidate in the scan but rejects one at the direct path", () => {
    mkdirSync(path.join(root, "projects", "other-project", "session-1.jsonl"), { recursive: true });
    const valid = writeTranscript("third-project", conversation.nativeId);
    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toMatchObject({
      status: "found",
      source: expect.objectContaining({ path: valid }),
    });

    mkdirSync(path.join(root, "projects", claudeProjectSlug(cwd), "session-1.jsonl"), { recursive: true });
    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("is not a file"),
    });
  });

  it("reports bad JSON in the probe as one could-not-verify failure", () => {
    const filePath = writeTranscript(claudeProjectSlug(cwd), null);
    writeFileSync(filePath, "not json\n", "utf8");

    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/^could not verify Claude transcript .*session-1\.jsonl: /),
    });
  });

  it("reports invalid UTF-8 before the first newline as unavailable", () => {
    const filePath = writeTranscript(claudeProjectSlug(cwd), null);
    writeFileSync(filePath, Buffer.from([0xff, 0x0a]));

    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("could not verify"),
    });
  });

  it("refuses to choose between two scanned transcripts", () => {
    writeTranscript("project-a", conversation.nativeId, conversation.nativeId);
    writeTranscript("project-b", conversation.nativeId, conversation.nativeId);

    expect(findClaudeSessionSource({ cwd, conversation, configDir: root })).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("multiple Claude transcripts"),
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

describe("claudeSourceFromPath", () => {
  it("qualifies a known transcript path without scanning the projects directory", () => {
    const filePath = "/nowhere/projects/-repo/session-1.jsonl";

    const source = claudeSourceFromPath(filePath, "host-a");

    expect(source).toEqual({
      sourceId: claudeSourceId("host-a", "session-1"),
      harness: "claude-code",
      format: CLAUDE_TRANSCRIPT_FORMAT,
      formatVersion: null,
      path: filePath,
      namespace: "host-a",
      conversation,
      provenance: { kind: "claude-code-transcript", legacySessionId: "session-1" },
    });
  });

  it("names a subagent sidechain by its agent ID rather than the filename prefix", () => {
    const source = claudeSourceFromPath("/nowhere/session-1/subagents/agent-a1b2.jsonl", "host-a");

    expect(source.conversation.nativeId).toBe("a1b2");
  });

  it("refuses a path that is not a JSONL transcript", () => {
    expect(() => claudeSourceFromPath("/nowhere/session-1.json", "host-a")).toThrow(/\.jsonl extension/);
  });

  it("refuses an empty namespace", () => {
    expect(() => claudeSourceFromPath("/nowhere/session-1.jsonl", " ")).toThrow(/nonempty/);
  });
});
