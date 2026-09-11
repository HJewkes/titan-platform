import type { createHash } from "node:crypto";
import type { LocatedSourceLine, ResumeBoundary, SessionSourceDescriptor } from "./normalized.js";
import { CODEX_ROLLOUT_FORMAT } from "./codex-discover.js";
import { TranscriptParseError } from "./read.js";
import { asObject, str, type Json } from "./text.js";

export interface CodexMessage {
  role: "user" | "assistant";
  parts: readonly { text: string; path: readonly (string | number)[] }[];
}

export const CALL_TYPES = new Set(["custom_tool_call", "function_call", "tool_search_call"]);
export const RESULT_TYPES = new Set(["custom_tool_call_output", "function_call_output", "tool_search_output"]);
export const COMPACTION_TYPES = new Set(["compaction", "compaction_trigger", "context_compaction"]);

export function validateCodexDescriptor(source: SessionSourceDescriptor): void {
  const valid = source.harness === "codex" && source.format === CODEX_ROLLOUT_FORMAT && source.namespace === source.conversation.namespace;
  if (!valid || source.conversation.harness !== "codex" || source.provenance.kind !== "codex-rollout") {
    throw new TypeError("Codex decoder requires a consistent codex-rollout source descriptor");
  }
}

export function parseCodexRecord(filePath: string, line: LocatedSourceLine): Json {
  try {
    const parsed = asObject(JSON.parse(line.raw));
    if (!parsed) throw new TypeError("record is not an object");
    return parsed;
  } catch (error) {
    throw new TranscriptParseError(filePath, line.evidence.byteOffset, error);
  }
}

export function readCanonicalMessage(payload: Json | null, subtype: string): CodexMessage | null {
  if (!payload || (subtype !== "message" && subtype !== "agent_message")) return null;
  const role = readRole(payload, subtype);
  if (!role) return null;
  const parts = messageParts(payload, subtype);
  return parts.length > 0 ? { role, parts } : null;
}

export function selectedValue(source: Json | null, keys: readonly string[]): { value: unknown; path: string | null } {
  for (const key of keys) if (source && key in source) return { value: source[key], path: key };
  return { value: null, path: null };
}

export function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function hasEncryptedContent(payload: Json | null): boolean | null {
  if (!payload) return null;
  return "encrypted_content" in payload || "encryptedContent" in payload ? true : null;
}

export function boundaryAt(byteOffset: number, digest: ReturnType<typeof createHash>): ResumeBoundary {
  return { byteOffset, prefixHash: digest.copy().digest("hex") };
}

export function sourceMismatch(source: SessionSourceDescriptor, observed: string | null): TypeError {
  return new TypeError(`rollout identity ${String(observed)} does not match discovered conversation ${source.conversation.nativeId}`);
}

function readRole(payload: Json, subtype: string): "user" | "assistant" | null {
  if (subtype === "agent_message") return "assistant";
  const role = str(payload, "role");
  return role === "user" || role === "assistant" ? role : null;
}

function messageParts(payload: Json, subtype: string): { text: string; path: readonly (string | number)[] }[] {
  if (subtype === "agent_message") return singleMessagePart(payload);
  if (!Array.isArray(payload.content)) return [];
  return payload.content.flatMap((value, index) => textFromContent(value, index));
}

function singleMessagePart(payload: Json): { text: string; path: readonly (string | number)[] }[] {
  const key = str(payload, "message") ? "message" : "text";
  const text = str(payload, key);
  return text ? [{ text, path: ["payload", key] }] : [];
}

function textFromContent(value: unknown, index: number): { text: string; path: readonly (string | number)[] }[] {
  if (typeof value === "string" && value.length > 0) return [{ text: value, path: ["payload", "content", index] }];
  const text = str(asObject(value), "text");
  return text ? [{ text, path: ["payload", "content", index, "text"] }] : [];
}
