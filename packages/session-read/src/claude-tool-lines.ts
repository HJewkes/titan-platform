import { claudeRecordTimestamp, readToolResult, readToolUse } from "./claude-tool-blocks.js";
import { asObject, blocks, str, type Json } from "./text.js";

interface ClaudeToolLineBase {
  callId: string;
  timestamp: string | null;
  sessionId: string | null;
  /** 0-based position in the input, counting blank and malformed lines. */
  lineIndex: number;
}

export interface ClaudeToolCallLine extends ClaudeToolLineBase {
  kind: "tool_call";
  name: string;
  input: unknown;
}

export interface ClaudeToolResultLine extends ClaudeToolLineBase {
  kind: "tool_result";
  output: unknown;
  isError: boolean | null;
}

export type ClaudeToolLine = ClaudeToolCallLine | ClaudeToolResultLine;

/**
 * Sync, descriptor-free decode of tool calls and results from raw Claude JSONL lines.
 * Skips blank, malformed and non-object lines, never checks session identity, and
 * yields a repeated call id every time it appears: joining and dedup are the caller's.
 */
export function* decodeClaudeToolLines(lines: Iterable<string>): Generator<ClaudeToolLine> {
  let lineIndex = 0;
  for (const raw of lines) {
    const record = parseToolRecord(raw);
    if (record) yield* toolLinesOf(record, lineIndex);
    lineIndex += 1;
  }
}

// Cheap prefilter: seat transcripts are large and most lines carry no tool block.
function parseToolRecord(raw: string): Json | null {
  if (!raw.includes('"tool_use"') && !raw.includes('"tool_result"')) return null;
  try {
    return asObject(JSON.parse(raw));
  } catch {
    return null;
  }
}

function* toolLinesOf(record: Json, lineIndex: number): Generator<ClaudeToolLine> {
  const base = { timestamp: claudeRecordTimestamp(record), sessionId: str(record, "sessionId"), lineIndex };
  for (const block of blocks(asObject(record.message))) {
    const type = str(block, "type");
    if (type === "tool_use") {
      const use = readToolUse(block);
      if (use) yield { kind: "tool_call", callId: use.callId, name: use.name, input: use.input, ...base };
    } else if (type === "tool_result") {
      const result = readToolResult(block);
      if (result) yield { kind: "tool_result", callId: result.callId, output: result.output, isError: result.isError, ...base };
    }
  }
}
