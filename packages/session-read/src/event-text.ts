import { promises as fs } from "node:fs";
import path from "node:path";
import { findClaudeSessionSource } from "./claude-source.js";
import { claudeTranscriptRoots, type TranscriptRoot } from "./discover.js";
import { asObject, stringLeaves } from "./text.js";

/** One transcript line: `byteLength` bytes at `byteOffset` of the session's transcript, newline excluded. */
export interface SessionEventRef {
  session: string;
  byteOffset: number;
  byteLength: number;
}

export interface ReadSessionEventTextOptions {
  /** The transcript roots searched for the session; defaults to {@link claudeTranscriptRoots}. */
  roots?: readonly TranscriptRoot[];
}

const NEWLINE = 0x0a;
/** Larger than any transcript line seen, small enough that a hostile length cannot exhaust memory. */
const MAX_EVENT_BYTES = 8 * 1024 * 1024;

function isSpan({ byteOffset, byteLength }: SessionEventRef): boolean {
  return Number.isSafeInteger(byteOffset) && byteOffset >= 0 && Number.isSafeInteger(byteLength) && byteLength >= 1 && byteLength <= MAX_EVENT_BYTES;
}

/** The one transcript holding `session` across every root; null when none or more than one does. */
function locateSession(session: string, roots: readonly TranscriptRoot[]): string | null {
  const found = new Set<string>();
  for (const { root, account } of roots) {
    // The cwd is unknown; the filesystem root slugs to no project, so the lookup scans every project directory.
    const lookup = findClaudeSessionSource({
      cwd: path.parse(root).root,
      configDir: path.dirname(root),
      conversation: { harness: "claude-code", namespace: account, nativeId: session },
    });
    if (lookup.status === "unavailable") return null;
    if (lookup.status === "found") found.add(lookup.source.path);
  }
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * The span's bytes when they are exactly one whole line: a newline (or the file start) just
 * before, a newline (or EOF) just after, and none inside. A span off a line boundary would let
 * a cite point at a fragment chosen to contain its own quote.
 */
async function readWholeLine(file: string, { byteOffset, byteLength }: SessionEventRef): Promise<Buffer | null> {
  const handle = await fs.open(file, "r");
  try {
    const start = Math.max(0, byteOffset - 1);
    const buffer = Buffer.alloc(byteOffset - start + byteLength + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const line = buffer.subarray(byteOffset - start, byteOffset - start + byteLength);
    if (bytesRead < buffer.length - 1 || line.includes(NEWLINE)) return null;
    const startsLine = byteOffset === 0 || buffer[0] === NEWLINE;
    const endsLine = bytesRead === buffer.length - 1 || buffer[buffer.length - 1] === NEWLINE;
    return startsLine && endsLine ? line : null;
  } finally {
    await handle.close();
  }
}

/** Every string in the record's message content: prose, thinking, tool input and tool result text. */
function contentText(line: Buffer): string | null {
  const record = asObject(JSON.parse(line.toString("utf8")));
  const leaves: string[] = [];
  stringLeaves(asObject(record?.message)?.content, leaves);
  return leaves.length > 0 ? leaves.join("\n") : null;
}

/**
 * The text of one Claude transcript event, for checking a quoted cite against it. Null when the
 * session is not found in exactly one transcript, the span is not one whole line, or the line
 * holds no message text; never throws.
 */
export async function readSessionEventText(ref: SessionEventRef, options: ReadSessionEventTextOptions = {}): Promise<string | null> {
  if (!isSpan(ref)) return null;
  try {
    const file = locateSession(ref.session, options.roots ?? claudeTranscriptRoots());
    const line = file && (await readWholeLine(file, ref));
    return line ? contentText(line) : null;
  } catch {
    return null;
  }
}
