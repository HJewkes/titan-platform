import { createReadStream, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

/**
 * Raw Claude Code transcripts, read as lines rather than through the session
 * graph. The graph's `fact` table carries no tool names, so the one place a
 * `Read` or an `agent_spawn` survives is the jsonl.
 */

export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
  timestamp?: string;
  sessionId?: string;
}

/** `~/.claude/projects` plus every profile's, since spawned agents run under profiles. */
export function defaultTranscriptRoots(home = homedir()): string[] {
  const roots = [path.join(home, ".claude", "projects")];
  const profiles = path.join(home, ".claude-profiles");
  if (!existsSync(profiles)) return roots;
  for (const entry of readdirSync(profiles, { withFileTypes: true })) {
    if (entry.isDirectory()) roots.push(path.join(profiles, entry.name, "projects"));
  }
  return roots;
}

export function discoverTranscripts(roots: string[]): string[] {
  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const project of readdirSync(root)) {
      const dir = path.join(root, project);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of entries) if (file.endsWith(".jsonl")) files.push(path.join(dir, file));
    }
  }
  return files.sort();
}

/** The uuid a transcript is named for, which is also the session id a record can cite. */
export function transcriptId(file: string): string {
  return path.basename(file, ".jsonl");
}

async function* lines(file: string): AsyncGenerator<string> {
  const stream = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of stream) yield line;
  } finally {
    stream.close();
  }
}

/**
 * Every `tool_use` in a transcript, in order.
 *
 * Parse failures are skipped rather than thrown: a transcript being appended to
 * while this runs ends in a half-written line, and one torn tail must not cost
 * the other 99% of the file.
 */
export async function* streamToolUses(file: string): AsyncGenerator<ToolUse> {
  for await (const line of lines(file)) {
    if (!line.includes('"tool_use"')) continue;
    const record = parseLine(line);
    const content = (record?.message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!isToolUse(item)) continue;
      yield {
        name: item.name,
        input: (item.input ?? {}) as Record<string, unknown>,
        timestamp: typeof record?.timestamp === "string" ? record.timestamp : undefined,
        sessionId: typeof record?.sessionId === "string" ? record.sessionId : undefined,
      };
    }
  }
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isToolUse(item: unknown): item is { type: string; name: string; input?: unknown } {
  const candidate = item as { type?: unknown; name?: unknown };
  return candidate?.type === "tool_use" && typeof candidate.name === "string";
}

export interface TranscriptHead {
  file: string;
  /** First timestamp on any line, used to order a child against its spawn. */
  startedAt?: string;
  /** Text of the first user turn: where a spawned agent's brief lands verbatim. */
  firstUserText: string;
  /** The `session_01…` id this transcript reports as its own, when it reports one. */
  harnessSessionId?: string;
}

/** Claude Code stamps the session's own web URL into an attachment; the id is in the path. */
const HARNESS_URL = /https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)/;

/**
 * Enough of a transcript's opening to identify it, without reading megabytes.
 *
 * `headLines` is a budget, not a guess about structure: the first user turn is
 * within the first few lines, and the harness url shows up in the same preamble.
 */
export async function readHead(file: string, headLines = 60): Promise<TranscriptHead> {
  const head: TranscriptHead = { file, firstUserText: "" };
  let seen = 0;
  for await (const line of lines(file)) {
    const match = HARNESS_URL.exec(line);
    if (match && head.harnessSessionId === undefined) head.harnessSessionId = match[1];
    const record = parseLine(line);
    if (record === undefined) continue;
    if (head.startedAt === undefined && typeof record.timestamp === "string") head.startedAt = record.timestamp;
    if (record.type === "user" && head.firstUserText === "") head.firstUserText = textOf(record.message);
    if (++seen >= headLines) break;
  }
  return head;
}

/** A turn's content is a string or a list of blocks; only the text of it matters here. */
export function textOf(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => (typeof item === "string" ? item : ((item as { text?: string })?.text ?? "")))
    .join("\n");
}
