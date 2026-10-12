import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Presence } from "../shepherd/presence.js";
import type { ReviewerAgent } from "../shepherd/review.js";
import type { TranscriptRow } from "../shepherd/reviewer-reader.js";

type Json = Record<string, unknown>;

/** A roster row the hold reads by name and the transcript reader reads by file, as one `agent ls --json` row carries both. */
export type SeatRow = ReviewerAgent & TranscriptRow & { transcriptPath: string };

let records = 0;

const stamp = (minute: number): string => new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString();

/** A transcript a reviewer writes into, one Claude Code JSONL record per call, each a minute after the one before. */
export class SeatTranscript {
  private minute = 0;

  constructor(
    readonly row: SeatRow,
    readonly file: string,
  ) {}

  /** A user message, which is how an agent-chat delivery from another agent lands in the reviewer's transcript. */
  user(text: string): this {
    return this.append({ type: "user", uuid: `user-${++records}`, message: { role: "user", content: text } });
  }

  /** Assistant text, the way a detached or exited reviewer ends its turn. */
  text(value: string): this {
    return this.assistant([{ type: "text", text: value }]);
  }

  /** A `chat_send` call whose result has not come back, so the turn is still open. */
  send(text: string, to = "coord"): this {
    return this.assistant([{ type: "tool_use", id: `tool-${++records}`, name: "mcp__plugin_agent-chat_agent-chat__chat_send", input: { to, text } }]);
  }

  private assistant(content: readonly Json[]): this {
    const id = ++records;
    return this.append({ type: "assistant", uuid: `assistant-${id}`, message: { id: `response-${id}`, role: "assistant", model: "claude-test", content } });
  }

  private append(record: Json): this {
    appendFileSync(this.file, `${JSON.stringify({ ...record, sessionId: this.row.sessionId, timestamp: stamp(++this.minute) })}\n`, "utf8");
    return this;
  }
}

/** An empty transcript under `dir` for the named agent's session, and its roster row. */
export function seatTranscript(dir: string, name: string, presence: Presence, spawnedBy = "coord"): SeatTranscript {
  const sessionId = `session-${name}`;
  const file = path.join(dir, name, `${sessionId}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "", "utf8");
  const row: SeatRow = { name, agentId: `agent-${name}`, sessionId, presence, spawnedBy, predecessor: null, transcriptPath: file, transcriptExists: true };
  return new SeatTranscript(row, file);
}
