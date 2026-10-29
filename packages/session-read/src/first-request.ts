import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { asObject, int, str, type Json } from "./text.js";

export type RequestSection = "tools" | "system" | "messages";

/** One text unit of the request in API order. `path` is `tools`, `system[2]` or `messages[0][4]`. */
export interface RequestBlock {
  section: RequestSection;
  path: string;
  text: string;
}

export interface CacheBreakpoint {
  path: string;
  type: string;
  ttl: string | null;
  scope: string | null;
}

export interface FirstRequestUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  outputTokens: number;
}

export interface FirstRequest {
  sessionId: string;
  agentName: string | null;
  model: string | null;
  timestamp: string | null;
  blocks: RequestBlock[];
  cacheControl: CacheBreakpoint[];
  /** Null when the transcript ends before the first response. */
  usage: FirstRequestUsage | null;
}

/** Keys sorted at every depth so the same tool block serialises to the same bytes whatever the writer's key order. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

function textOf(block: Json): string {
  return typeof block.text === "string" ? block.text : sortedJson(block);
}

function shapeBlocks(shape: Json | null): RequestBlock[] {
  const blocks: RequestBlock[] = [];
  const tools = shape?.tools;
  if (Array.isArray(tools)) blocks.push({ section: "tools", path: "tools", text: sortedJson(tools) });
  const system = shape?.system;
  if (Array.isArray(system)) {
    system.forEach((entry, i) => blocks.push({ section: "system", path: `system[${i}]`, text: textOf(asObject(entry) ?? {}) }));
  }
  return blocks;
}

/** A string message body is one block; a block list is one block per entry. */
function messageBlocks(message: Json | null, messageIndex: number): RequestBlock[] {
  const content = message?.content;
  const entries = typeof content === "string" ? [{ text: content }] : Array.isArray(content) ? content : [];
  return entries.map((entry, i) => ({
    section: "messages",
    path: `messages[${messageIndex}][${i}]`,
    text: textOf(asObject(entry) ?? {}),
  }));
}

function breakpoints(raw: unknown): CacheBreakpoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const row = asObject(entry);
    const value = asObject(row?.value);
    const parts = row?.path;
    if (!Array.isArray(parts) || !value) return [];
    const path = parts.reduce<string>((acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${String(part)}` : String(part)), "");
    return [{ path, type: str(value, "type") ?? "", ttl: str(value, "ttl"), scope: str(value, "scope") }];
  });
}

function usageOf(message: Json | null): FirstRequestUsage | null {
  const usage = asObject(message?.usage);
  if (!usage) return null;
  const split = asObject(usage.cache_creation);
  return {
    inputTokens: int(usage, "input_tokens"),
    cacheReadTokens: int(usage, "cache_read_input_tokens"),
    cacheCreationTokens: int(usage, "cache_creation_input_tokens"),
    cacheCreation5mTokens: int(split, "ephemeral_5m_input_tokens"),
    cacheCreation1hTokens: int(split, "ephemeral_1h_input_tokens"),
    outputTokens: int(usage, "output_tokens"),
  };
}

interface Scan {
  sessionId: string | null;
  agentName: string | null;
  shapes: Map<string, Json>;
  blobs: Map<string, Json>;
  request: Json | null;
  response: Json | null;
}

function absorb(scan: Scan, line: Json): void {
  const type = str(line, "type");
  if (type === "agent-name") scan.agentName ??= str(line, "agentName");
  else if (type === "api-request-shape") {
    const hash = str(line, "shapeHash");
    const shape = asObject(line.shape);
    if (hash && shape) scan.shapes.set(hash, shape);
  } else if (type === "api-request-blob") {
    const hash = str(line, "hash");
    const message = asObject(line.message);
    if (hash && message) scan.blobs.set(hash, message);
  } else if (type === "api-request") scan.request ??= line;
  else if (type === "assistant" && scan.request && !scan.response) {
    const ref = str(line, "requestRef");
    if (!ref || ref === str(scan.request, "id")) scan.response = line;
  }
  scan.sessionId ??= str(line, "sessionId");
}

function assemble(scan: Scan): FirstRequest | null {
  const { request } = scan;
  if (!request) return null;
  const tail = Array.isArray(request.tail) ? request.tail : [];
  // The blob rows sit in the file in write order; only the request's `tail` says which message each one is.
  const messages = tail.flatMap((hash, i) => {
    const blob = typeof hash === "string" ? scan.blobs.get(hash) : undefined;
    return blob ? messageBlocks(blob, i) : [];
  });
  const shapeHash = str(request, "shapeHash");
  const shape = shapeHash ? (scan.shapes.get(shapeHash) ?? null) : null;
  const response = asObject(scan.response?.message);
  return {
    sessionId: scan.sessionId ?? "",
    agentName: scan.agentName,
    model: str(asObject(request.params), "model") ?? str(response, "model"),
    timestamp: str(request, "timestamp"),
    blocks: [...shapeBlocks(shape), ...messages],
    cacheControl: breakpoints(request.cacheControl),
    usage: usageOf(response),
  };
}

function parseLine(text: string): Json | null {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * Rebuild the first API request a Claude Code transcript recorded, in API order (tools, system, messages),
 * with the cache breakpoints it carried and the usage its response reported. Null when the transcript has
 * no `api-request` row. Streams the file and stops once the first response is read.
 */
export async function readFirstRequest(path: string): Promise<FirstRequest | null> {
  const scan: Scan = { sessionId: null, agentName: null, shapes: new Map(), blobs: new Map(), request: null, response: null };
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const text of lines) {
      if (!text.trim()) continue;
      const line = parseLine(text);
      if (line) absorb(scan, line);
      if (scan.response) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return assemble(scan);
}
