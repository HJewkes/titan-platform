import type { TokenCounts } from "@titan-design/agent-protocol";
import type { NormalizedNativeExtension } from "./normalized.js";
import { asObject, str, type Json } from "./text.js";

export interface ClaudeTextPart {
  text: string;
  path: readonly (string | number)[];
}

export function messageTextParts(content: unknown, path: readonly (string | number)[]): ClaudeTextPart[] {
  if (typeof content === "string") return content.length > 0 ? [{ text: content, path }] : [];
  if (!Array.isArray(content)) return [];
  const parts: ClaudeTextPart[] = [];
  content.forEach((value, index) => {
    const block = asObject(value);
    const text = str(block, "text");
    if (block?.type === "text" && text) parts.push({ text, path: [...path, index, "text"] });
  });
  return parts;
}

export function metadataEntries(record: Json, message: Json | null) {
  const entries: { name: string; value: unknown; meaning: "normalized" | "native" }[] = [];
  const add = (source: Json | null, name: string, meaning: "normalized" | "native") => {
    if (source && name in source) entries.push({ name, value: source[name], meaning });
  };
  add(record, "cwd", "normalized");
  if ("gitBranch" in record) entries.push({ name: "git_branch", value: record.gitBranch, meaning: "normalized" });
  if ("version" in record) entries.push({ name: "cli_version", value: record.version, meaning: "normalized" });
  if ("aiTitle" in record) entries.push({ name: "title", value: record.aiTitle, meaning: "normalized" });
  if ("lastPrompt" in record) entries.push({ name: "seed_prompt", value: record.lastPrompt, meaning: "normalized" });
  for (const name of ["gitBranch", "version", "entrypoint", "aiTitle", "lastPrompt", "slug", "permissionMode", "isSidechain", "toolDenialKind", "logicalParentUuid", "compactMetadata", "preventedContinuation", "hookInfos", "hookCount", "planContent"] as const) {
    add(record, name, "native");
  }
  add(message, "model", "normalized");
  const usage = asObject(message?.usage);
  add(usage, "service_tier", "native");
  return entries;
}

export function nativeExtensionsForRecord(record: Json, message: Json | null): NormalizedNativeExtension[] {
  const out: NormalizedNativeExtension[] = [];
  for (const name of ["slug", "isSidechain", "toolDenialKind", "permissionMode", "logicalParentUuid", "compactMetadata", "preventedContinuation", "hookInfos", "hookCount", "planContent"] as const) {
    if (name in record) out.push({ name, value: record[name] });
  }
  const usage = asObject(message?.usage);
  if (usage && "service_tier" in usage) out.push({ name: "service_tier", value: usage.service_tier });
  return out;
}

export function tokenCounts(usage: Json): TokenCounts {
  const directInput = count(usage.input_tokens);
  const cachedInput = count(usage.cache_read_input_tokens);
  const cacheWriteInput = count(usage.cache_creation_input_tokens);
  const output = count(usage.output_tokens);
  const input = directInput === null || cachedInput === null || cacheWriteInput === null ? null : directInput + cachedInput + cacheWriteInput;
  return { input, output, cachedInput, cacheWriteInput, reasoningOutput: null, total: input === null || output === null ? null : input + output };
}

export function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function selectedSystemFields(record: Json): Json {
  const selected: Json = {};
  for (const name of ["subtype", "level", "message", "hookCount", "hookInfos", "preventedContinuation", "toolUseID", "toolUseId", "stopReason"] as const) {
    if (name in record) selected[name] = record[name];
  }
  return selected;
}

export function extractCompactionSummary(text: string): string | null {
  const markerEnd = text.indexOf("\n\n");
  if (markerEnd < 0) return null;
  const summary = text.slice(markerEnd + 2).trim();
  return summary.length > 0 ? summary : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
