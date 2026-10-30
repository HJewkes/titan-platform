import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationIdentity } from "@titan-design/agent-protocol";
import { isMissing, isNameTooLong, messageOf } from "./absent.js";
import type { SessionSourceDescriptor } from "./normalized.js";
import { asObject } from "./text.js";

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

  const projects = projectsDir(input.configDir);
  const filename = `${input.conversation.nativeId}.jsonl`;
  const expectedPath = path.join(projects, claudeProjectSlug(input.cwd), filename);
  const direct = inspectFile(expectedPath);
  if (direct.status === "missing") return scanProjects(projects, filename, input.conversation, expectedPath);
  if (direct.status === "error") return { status: "unavailable", reason: direct.reason };

  const probe = verifyConversation(expectedPath, input.conversation.nativeId);
  switch (probe.status) {
    case "match":
      return { status: "found", source: descriptor(expectedPath, input.conversation) };
    case "unwritten":
      return { status: "not_written", expectedPath };
    default:
      return { status: "unavailable", reason: probe.reason };
  }
}

function projectsDir(configDir: string | undefined): string {
  const root = path.resolve(configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));
  return path.join(root, "projects");
}

function scanProjects(projects: string, filename: string, conversation: ConversationIdentity, expectedPath: string): SessionSourceLookup {
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
    const result = scanCandidate(candidate, conversation.nativeId);
    if (result.status === "error") return { status: "unavailable", reason: result.reason };
    if (result.status === "match") matches.set(result.real, candidate);
  }
  const first = matches.values().next();
  if (first.done) return { status: "not_written", expectedPath };
  if (matches.size > 1) return { status: "unavailable", reason: `multiple Claude transcripts match native session ${conversation.nativeId}` };
  return { status: "found", source: descriptor(first.value, conversation) };
}

type CandidateResult = { status: "skip" } | { status: "match"; real: string } | { status: "error"; reason: string };

/** Unlike the direct path, a scan skips anything that is not a verified match: other sessions are expected there. */
function scanCandidate(candidate: string, nativeId: string): CandidateResult {
  if (inspectFile(candidate).status !== "file") return { status: "skip" };
  const probe = verifyConversation(candidate, nativeId);
  if (probe.status === "unwritten" || probe.status === "mismatch") return { status: "skip" };
  if (probe.status === "error") return probe;
  try {
    return { status: "match", real: realpathSync(candidate) };
  } catch (error) {
    return { status: "error", reason: `could not resolve Claude transcript ${candidate}: ${messageOf(error)}` };
  }
}

/** Describe a transcript whose path is already known; the native ID comes from its filename. */
export function claudeSourceFromPath(filePath: string, namespace: string): SessionSourceDescriptor {
  const stem = path.basename(filePath, ".jsonl");
  const nativeId = stem.startsWith("agent-") ? stem.slice("agent-".length) : stem;
  const source = descriptor(filePath, { harness: "claude-code", namespace, nativeId });
  assertClaudeSessionSource(source);
  return source;
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

type FileState = { status: "file" } | { status: "missing" } | { status: "error"; reason: string };

function inspectFile(filePath: string): FileState {
  try {
    return statSync(filePath).isFile() ? { status: "file" } : { status: "error", reason: `Claude transcript path is not a file: ${filePath}` };
  } catch (error) {
    // Claude shortens a long cwd's directory name, so the exact slug can pass the name limit while the transcript is still there to scan for.
    if (isMissing(error) || isNameTooLong(error)) return { status: "missing" };
    return { status: "error", reason: `could not inspect Claude transcript ${filePath}: ${messageOf(error)}` };
  }
}

type IdentityProbe =
  | { status: "match" }
  | { status: "unwritten" }
  | { status: "mismatch"; reason: string }
  | { status: "error"; reason: string };

/** Bounded identity probe; an empty or still-partial new file is not written yet. */
function verifyConversation(filePath: string, nativeId: string): IdentityProbe {
  let handle: number | undefined;
  try {
    handle = openSync(filePath, "r");
    const prefix = readPrefixLines(handle, statSync(filePath).size, filePath);
    if (prefix.status !== "lines") return prefix;
    const sessionId = firstSessionId(prefix.lines);
    if (sessionId === null) {
      return { status: "error", reason: `Claude transcript ${filePath} has complete records but no native session identity within the bounded probe` };
    }
    if (sessionId === nativeId) return { status: "match" };
    return { status: "mismatch", reason: `Claude transcript ${filePath} contains session ${sessionId}, expected ${nativeId}` };
  } catch (error) {
    return { status: "error", reason: `could not verify Claude transcript ${filePath}: ${messageOf(error)}` };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

type PrefixLines = { status: "lines"; lines: string[] } | { status: "unwritten" } | { status: "error"; reason: string };

/** Complete lines of the first 256 KiB; throws on invalid UTF-8. */
function readPrefixLines(handle: number, size: number, filePath: string): PrefixLines {
  if (size === 0) return { status: "unwritten" };
  const bytes = Buffer.alloc(Math.min(size, 256 * 1024));
  const length = readSync(handle, bytes, 0, bytes.length, 0);
  const lastNewline = bytes.subarray(0, length).lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return length < size
      ? { status: "error", reason: `Claude transcript ${filePath} has no complete identity record within the bounded probe` }
      : { status: "unwritten" };
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, lastNewline + 1));
  return { status: "lines", lines: text.split("\n") };
}

/** The first record's explicit session ID, or null; throws on a line that is not JSON. */
function firstSessionId(lines: string[]): string | null {
  for (const line of lines) {
    if (!line.trim()) continue;
    const value = asObject(JSON.parse(line));
    if (!value) continue;
    const sessionId = value.sessionId;
    if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  }
  return null;
}
