import { execFile } from "node:child_process";
import os from "node:os";
import { readLocatorText } from "@titan-design/locator";
import { expandHome } from "@titan-design/session-read";
import type { Db } from "@titan-design/store-sqlite";

/** A Bash tool call in the graph, located in its transcript; the graph keeps no command text. */
export interface BashCall {
  sessionId: string;
  toolUseId: string;
  /** As the graph stores it, which may start with `~/`. */
  path: string;
  byteOffset: number;
  /** Null when the call has no fact row to give the line's length, so it cannot be read back. */
  byteLength: number | null;
  /** The `command_heads` signal, written by newer extractors only. */
  heads: string | null;
}

const BASH_CALLS = `
  SELECT tc.session_id AS sessionId, tc.tool_use_id AS toolUseId, t.source_key AS path, tc.byte_offset AS byteOffset,
         f.byte_length AS byteLength, s.detail AS heads
  FROM tool_call tc
  JOIN transcript t ON t.source_id = tc.transcript_id
  LEFT JOIN fact f ON f.transcript_id = tc.transcript_id AND f.byte_offset = tc.byte_offset
  LEFT JOIN session_signal s ON s.transcript_id = tc.transcript_id AND s.byte_offset = tc.byte_offset
       AND s.block_index = tc.block_index AND s.signal = 'command_heads'
  WHERE tc.name = 'Bash' AND (@since IS NULL OR tc.ts >= @since) AND (@until IS NULL OR tc.ts < @until)`;

export function readBashCalls(db: Db, window: { since?: string; until?: string }): BashCall[] {
  return db.prepare(BASH_CALLS).all({ since: window.since ?? null, until: window.until ?? null }) as BashCall[];
}

export function readAgentNames(db: Db): Map<string, string> {
  const rows = db.prepare("SELECT session_id AS sessionId, agent_name AS agentName FROM session_origin WHERE agent_name IS NOT NULL").all() as { sessionId: string; agentName: string }[];
  return new Map(rows.map((r) => [r.sessionId, r.agentName]));
}

/** Characters of the tool result that reached the model's context for one call. */
export function outputCharsReader(db: Db): (call: Pick<BashCall, "sessionId" | "toolUseId">) => number {
  const sum = db.prepare("SELECT COALESCE(SUM(chars), 0) AS chars FROM context_block WHERE session_id = ? AND source = 'tool_result' AND tool_use_id = ?");
  return (call) => (sum.get(call.sessionId, call.toolUseId) as { chars: number }).chars;
}

interface ToolUseBlock {
  type?: unknown;
  id?: unknown;
  input?: { command?: unknown };
}

/** The `command` input of the call's `tool_use` block, or null when the line is gone, moved or not that call. */
export async function readBashCommand(call: BashCall, home: string = os.homedir()): Promise<string | null> {
  if (call.byteLength === null) return null;
  try {
    const line = JSON.parse(await readLocatorText(expandHome(call.path, home), [0, call.byteOffset, call.byteLength])) as { message?: { content?: unknown } };
    const content = line.message?.content;
    const block = Array.isArray(content) ? (content as ToolUseBlock[]).find((b) => b?.type === "tool_use" && b.id === call.toolUseId) : undefined;
    return typeof block?.input?.command === "string" ? block.input.command : null;
  } catch {
    return null;
  }
}

const HELP_TIMEOUT_MS = 15_000;

/** `<argv> --help`, stdout and stderr together, since some CLIs print usage to stderr with a non-zero exit; null when it cannot run. */
export function runHelp(argv: readonly string[]): Promise<string | null> {
  const [program, ...rest] = argv;
  if (!program) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(program, [...rest, "--help"], { timeout: HELP_TIMEOUT_MS, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      const text = `${stdout}${stderr}`;
      resolve((error as NodeJS.ErrnoException | null)?.code === "ENOENT" || text.trim() === "" ? null : text);
    });
  });
}
