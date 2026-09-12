import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationIdentity } from "@titan-design/agent-protocol";
import type { SessionSourceDescriptor } from "./normalized.js";

export const CLAUDE_TRANSCRIPT_FORMAT = "claude-code-jsonl";

export interface FindClaudeSessionSourceInput {
  cwd: string;
  conversation: ConversationIdentity;
  /** Claude configuration root. Defaults to CLAUDE_CONFIG_DIR or ~/.claude. */
  configDir?: string;
}

export type SessionSourceLookup =
  | { status: "found"; source: SessionSourceDescriptor }
  | { status: "not_written"; expectedPath: string }
  | { status: "unavailable"; reason: string };

/** Claude's lossy cwd-to-project-directory mapping. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function claudeSourceId(namespace: string, nativeId: string): string {
  return `claude-code:${encodeURIComponent(namespace)}:${encodeURIComponent(nativeId)}`;
}

/** Locate one ordinary Claude transcript by exact native session ID. */
export function findClaudeSessionSource(input: FindClaudeSessionSourceInput): SessionSourceLookup {
  const invalid = identityProblem(input.conversation);
  if (invalid) return { status: "unavailable", reason: invalid };
  if (!path.isAbsolute(input.cwd)) return { status: "unavailable", reason: "Claude source lookup requires an absolute cwd" };

  const root = path.resolve(input.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));
  const projects = path.join(root, "projects");
  const filename = `${input.conversation.nativeId}.jsonl`;
  const expectedPath = path.join(projects, claudeProjectSlug(input.cwd), filename);
  const direct = readableFile(expectedPath);
  if (direct === true) {
    const verified = verifyConversation(expectedPath, input.conversation.nativeId);
    if (verified === true) return { status: "found", source: descriptor(expectedPath, input.conversation) };
    if (verified === false) return { status: "not_written", expectedPath };
    return { status: "unavailable", reason: verified.reason };
  }
  if (typeof direct === "string") return { status: "unavailable", reason: direct };

  let projectDirs;
  try {
    projectDirs = readdirSync(projects, { withFileTypes: true });
  } catch (error) {
    return isMissing(error)
      ? { status: "not_written", expectedPath }
      : { status: "unavailable", reason: `could not scan Claude projects: ${messageOf(error)}` };
  }

  const matches = new Map<string, string>();
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projects, entry.name, filename);
    const state = readableFile(candidate);
    if (state !== true) continue;
    const verified = verifyConversation(candidate, input.conversation.nativeId);
    if (verified === false) continue;
    if (verified !== true && verified.kind === "mismatch") continue;
    if (verified !== true) return { status: "unavailable", reason: verified.reason };
    try {
      matches.set(realpathSync(candidate), candidate);
    } catch (error) {
      return { status: "unavailable", reason: `could not resolve Claude transcript ${candidate}: ${messageOf(error)}` };
    }
  }
  if (matches.size === 0) return { status: "not_written", expectedPath };
  if (matches.size > 1) return { status: "unavailable", reason: `multiple Claude transcripts match native session ${input.conversation.nativeId}` };
  const found = matches.values().next().value as string;
  return { status: "found", source: descriptor(found, input.conversation) };
}

/** Reject descriptors whose path or provenance could name another conversation. */
export function assertClaudeSessionSource(source: SessionSourceDescriptor): void {
  const problem = identityProblem(source.conversation);
  if (problem) throw new TypeError(problem);
  if (source.harness !== "claude-code" || source.format !== CLAUDE_TRANSCRIPT_FORMAT) {
    throw new TypeError("source is not a Claude Code transcript");
  }
  if (source.namespace !== source.conversation.namespace) throw new TypeError("Claude source namespace does not match its conversation");
  if (source.provenance.kind !== "claude-code-transcript") throw new TypeError("Claude source requires explicit transcript provenance");
  if (source.provenance.legacySessionId !== source.conversation.nativeId) {
    throw new TypeError("Claude transcript provenance does not match its conversation");
  }
  if (source.sourceId !== claudeSourceId(source.namespace, source.conversation.nativeId)) {
    throw new TypeError("Claude source ID does not match its conversation");
  }
  if (!source.sourceId.trim() || !source.path.trim()) throw new TypeError("Claude source ID and path must be nonempty");
  if (path.extname(source.path) !== ".jsonl") throw new TypeError("Claude transcript path must have a .jsonl extension");
  const stem = path.basename(source.path, ".jsonl");
  if (stem !== source.conversation.nativeId && stem !== `agent-${source.conversation.nativeId}`) {
    throw new TypeError("Claude transcript filename does not match its conversation");
  }
}

function descriptor(filePath: string, conversation: ConversationIdentity): SessionSourceDescriptor {
  return {
    sourceId: claudeSourceId(conversation.namespace, conversation.nativeId),
    harness: "claude-code",
    format: CLAUDE_TRANSCRIPT_FORMAT,
    formatVersion: null,
    path: filePath,
    namespace: conversation.namespace,
    conversation,
    provenance: { kind: "claude-code-transcript", legacySessionId: conversation.nativeId },
  };
}

function identityProblem(conversation: ConversationIdentity): string | null {
  if (conversation.harness !== "claude-code") return "Claude source lookup requires a claude-code conversation";
  if (!conversation.namespace.trim() || !conversation.nativeId.trim()) return "Claude conversation identity components must be nonempty";
  if (
    conversation.nativeId === "." ||
    conversation.nativeId === ".." ||
    conversation.nativeId.includes("/") ||
    conversation.nativeId.includes("\\") ||
    path.basename(conversation.nativeId) !== conversation.nativeId
  ) {
    return "Claude native session ID must be one filename component";
  }
  if (conversation.nativeId.includes("\0")) return "Claude native session ID cannot contain a NUL byte";
  return null;
}

/** A record belongs to an ordinary transcript when its explicit session ID agrees. */
export function claudeRecordBelongsToSource(source: SessionSourceDescriptor, record: Record<string, unknown>): boolean {
  const nativeId = typeof record.sessionId === "string" && record.sessionId.length > 0 ? record.sessionId : null;
  if (!nativeId || nativeId === source.conversation.nativeId) return true;
  return path.basename(source.path) === `agent-${source.conversation.nativeId}.jsonl`;
}

function readableFile(filePath: string): true | false | string {
  try {
    return statSync(filePath).isFile() ? true : `Claude transcript path is not a file: ${filePath}`;
  } catch (error) {
    return isMissing(error) ? false : `could not inspect Claude transcript ${filePath}: ${messageOf(error)}`;
  }
}

/** Bounded identity probe; an empty or still-partial new file is not written yet. */
function verifyConversation(filePath: string, nativeId: string): true | false | { kind: "mismatch" | "error"; reason: string } {
  let handle: number | undefined;
  try {
    handle = openSync(filePath, "r");
    const size = statSync(filePath).size;
    if (size === 0) return false;
    const bytes = Buffer.alloc(Math.min(size, 256 * 1024));
    const length = readSync(handle, bytes, 0, bytes.length, 0);
    const lastNewline = bytes.subarray(0, length).lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return length < size
        ? { kind: "error", reason: `Claude transcript ${filePath} has no complete identity record within the bounded probe` }
        : false;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, lastNewline + 1));
    } catch (error) {
      return { kind: "error", reason: `could not verify Claude transcript ${filePath}: ${messageOf(error)}` };
    }
    const lines = text.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        return { kind: "error", reason: `could not verify Claude transcript ${filePath}: ${messageOf(error)}` };
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const sessionId = (value as Record<string, unknown>).sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        return sessionId === nativeId
          ? true
          : { kind: "mismatch", reason: `Claude transcript ${filePath} contains session ${sessionId}, expected ${nativeId}` };
      }
    }
    return {
      kind: "error",
      reason: `Claude transcript ${filePath} has complete records but no native session identity within the bounded probe`,
    };
  } catch (error) {
    return { kind: "error", reason: `could not verify Claude transcript ${filePath}: ${messageOf(error)}` };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
