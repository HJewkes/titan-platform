import { booleanOrNull, str, type Json } from "./text.js";

export interface ToolUseBlock {
  callId: string;
  name: string;
  input: unknown;
  hasInput: boolean;
}

export interface ToolResultBlock {
  callId: string;
  output: unknown;
  isError: boolean | null;
  hasOutput: boolean;
}

export function readToolUse(block: Json | null): ToolUseBlock | null {
  const callId = str(block, "id");
  if (!block || !callId) return null;
  return { callId, name: str(block, "name") ?? "unknown", input: block.input, hasInput: "input" in block };
}

export function readToolResult(block: Json | null): ToolResultBlock | null {
  const callId = str(block, "tool_use_id");
  if (!block || !callId) return null;
  return { callId, output: block.content, isError: booleanOrNull(block.is_error), hasOutput: "content" in block };
}

export function claudeRecordTimestamp(record: Json): string | null {
  return str(record, "timestamp") || null;
}
