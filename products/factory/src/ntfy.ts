import { readFileSync } from "node:fs";
import type { DigestPushConfig } from "./config.js";

export interface NtfyDeps {
  fetch?: typeof fetch;
  readFile?: (path: string) => string;
}

export interface NtfyMessage {
  title: string;
  message: string;
  click?: string;
  tags?: readonly string[];
}

type NtfyResult = { ok: true } | { ok: false; warning: string };

/** The bearer header when a token file is configured; throws if the file cannot be read, so callers keep it inside their try. */
export function authHeaders(push: DigestPushConfig, deps: NtfyDeps): Record<string, string> {
  if (!push.tokenFile) return {};
  return { Authorization: `Bearer ${(deps.readFile ?? ((path) => readFileSync(path, "utf8")))(push.tokenFile).trim()}` };
}

/** The error text with the topic URL, and its path, removed: on an anonymous topic the URL is the only credential. */
export function scrubbed(error: unknown, url: string): string {
  const text = error instanceof Error ? error.message : String(error);
  const topic = URL.canParse(url) ? new URL(url).pathname : "";
  const bare = text.split(url).join("<url>");
  return topic.length > 1 ? bare.split(topic).join("<topic>") : bare;
}

/** A header value cannot hold a newline. */
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, " ").trim();

/** Publishes one line to the topic. Never throws, and its warning never names the topic URL. */
export async function ntfyPublish(push: DigestPushConfig, msg: NtfyMessage, deps: NtfyDeps = {}): Promise<NtfyResult> {
  const send = deps.fetch ?? fetch;
  try {
    const headers: Record<string, string> = { ...authHeaders(push, deps), Title: oneLine(msg.title) };
    if (msg.click) headers.Click = oneLine(msg.click);
    if (msg.tags?.length) headers.Tags = msg.tags.join(",");
    const response = await send(push.url, { method: "POST", headers, body: msg.message });
    return response.ok ? { ok: true } : { ok: false, warning: `push failed: HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, warning: `push failed: ${scrubbed(error, push.url)}` };
  }
}
