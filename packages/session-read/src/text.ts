import type { SpanField } from "./events.js";

export type Json = Record<string, unknown>;

export function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

export function str(source: Json | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function int(source: Json | null, key: string): number {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function blocks(message: Json | null): Json[] {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.map(asObject).filter((b): b is Json => b !== null);
}

/**
 * Per-span cap on indexed text. A pasted build log or a 2 MB file read would
 * otherwise dominate the FTS index for no retrieval benefit; the locator still
 * points at the full record on disk.
 */
export const SPAN_TEXT_CAP = 16 * 1024;

/**
 * The string leaves of a parsed tool input. Not `JSON.stringify`: raw JSON
 * would fill the index with field names (`file_path`, `old_string`) that match
 * every document and discriminate nothing.
 */
export function stringLeaves(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || out.length > 64) return;
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringLeaves(item, out, depth + 1);
    return;
  }
  const object = asObject(value);
  if (!object) return;
  if (isTextBlock(object)) {
    stringLeaves(object.text, out, depth + 1);
    return;
  }
  for (const item of Object.values(object)) stringLeaves(item, out, depth + 1);
}

/** Bounded semantic text projection shared by normalized indexing and locator readback. */
export function normalizedSearchText(value: unknown): string {
  if (Array.isArray(value) && value.every(item => {
    const block = asObject(item);
    return block && ["text", "input_text", "output_text"].includes(String(block.type)) && typeof block.text === "string";
  })) return value.map(item => (item as { text: string }).text).join("\n").slice(0, SPAN_TEXT_CAP);
  const leaves: string[] = [];
  stringLeaves(value, leaves);
  return leaves.join("\n").slice(0, SPAN_TEXT_CAP);
}

function isTextBlock(value: Json): value is Json & { text: string } {
  return (
    (value.type === "input_text" || value.type === "output_text" || value.type === "text") &&
    typeof value.text === "string"
  );
}

/** A `tool_result` block's content is either a bare string or text blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => str(asObject(block), "text") ?? "")
    .filter(Boolean)
    .join("\n");
}

/**
 * The share of `output_tokens` attributable to extended thinking, estimated
 * from the character share of thinking blocks against all generated content on
 * the same line. Stateless per line, so incremental and full passes agree.
 */
export function thinkingTokens(message: Json | null, outputTokens: number): number {
  if (outputTokens <= 0) return 0;
  let thinking = 0;
  let total = 0;
  for (const block of blocks(message)) {
    const leaves: string[] = [];
    if (block.type === "thinking") stringLeaves(block.thinking, leaves);
    else if (block.type === "text") stringLeaves(block.text, leaves);
    else if (block.type === "tool_use") stringLeaves(block.input, leaves);
    else continue;
    const length = leaves.reduce((sum, part) => sum + part.length, 0);
    total += length;
    if (block.type === "thinking") thinking += length;
  }
  if (total === 0 || thinking === 0) return 0;
  return Math.min(outputTokens, Math.round((outputTokens * thinking) / total));
}

/** The prose of a line for one search field. The caller indexes it and discards it. */
export function searchText(message: Json | null, field: SpanField): string {
  const content = message?.content;
  if (typeof content === "string") return content.slice(0, SPAN_TEXT_CAP);
  const parts: string[] = [];
  for (const block of blocks(message)) {
    if (field === "tool_input") {
      if (block.type === "tool_use") stringLeaves(block.input, parts);
    } else if (field === "tool_result") {
      if (block.type === "tool_result") parts.push(toolResultText(block.content));
    } else if (block.type === "text") {
      parts.push(str(block, "text") ?? "");
    }
  }
  return parts.filter(Boolean).join("\n").slice(0, SPAN_TEXT_CAP);
}
