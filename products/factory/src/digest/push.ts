import { readFileSync } from "node:fs";
import type { DigestPushConfig } from "../config.js";
import type { DigestSlot } from "./model.js";

export const HEADLINE_LINES = 3;
export const FALLBACK_BODY_BYTES = 4096;

export interface PushDeps {
  fetch?: typeof fetch;
  readFile?: (path: string) => string;
}

/** The first non-empty lines, minus markdown heading marks; an ntfy message header cannot hold a newline. */
function headline(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter((line) => line !== "")
    .slice(0, HEADLINE_LINES)
    .join(" | ");
}

/** Cuts on a byte budget without splitting a multibyte character. */
function truncateBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  return bytes.subarray(0, limit).toString("utf8").replace(/�$/, "");
}

/** The error text with the topic URL removed, since the URL is the only credential an anonymous topic has. */
function describe(error: unknown, url: string): string {
  return (error instanceof Error ? error.message : String(error)).split(url).join("<url>");
}

/**
 * Pushes the digest to an ntfy topic: the markdown attached, else a 4 KB body. Returns a warning, never throws,
 * because the file on disk is the delivery and the push is a courtesy.
 */
export async function pushDigest(markdown: string, slot: DigestSlot, push: DigestPushConfig, deps: PushDeps = {}): Promise<string | undefined> {
  const send = deps.fetch ?? fetch;
  const headers: Record<string, string> = { Title: `Digest ${slot.date} ${slot.hour}:00`, Markdown: "yes" };
  try {
    if (push.tokenFile) headers.Authorization = `Bearer ${(deps.readFile ?? ((path) => readFileSync(path, "utf8")))(push.tokenFile).trim()}`;
    const attached = await send(push.url, {
      method: "PUT",
      headers: { ...headers, Filename: `${slot.date}-${slot.hour}.md`, Message: headline(markdown) },
      body: markdown,
    }).catch(() => undefined);
    if (attached?.ok) return undefined;
    const fallback = await send(push.url, { method: "POST", headers, body: truncateBytes(markdown, FALLBACK_BODY_BYTES) });
    return fallback.ok ? undefined : `push failed: HTTP ${fallback.status}`;
  } catch (error) {
    return `push failed: ${describe(error, push.url)}`;
  }
}
