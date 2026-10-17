import type { DigestPushConfig } from "../config.js";
import { authHeaders, scrubbed, type NtfyDeps } from "../ntfy.js";
import type { DigestSlot } from "./model.js";

const HEADLINE_LINES = 3;
const FALLBACK_BODY_BYTES = 4096;

export type PushDeps = NtfyDeps;

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

/**
 * Pushes the digest to an ntfy topic: the markdown attached, else a 4 KB body. Returns a warning, never throws,
 * because the file on disk is the delivery and the push is a courtesy.
 */
export async function pushDigest(markdown: string, slot: DigestSlot, push: DigestPushConfig, deps: PushDeps = {}): Promise<string | undefined> {
  const send = deps.fetch ?? fetch;
  const headers: Record<string, string> = { Title: `Digest ${slot.date} ${slot.hour}:00`, Markdown: "yes" };
  try {
    Object.assign(headers, authHeaders(push, deps));
    const attached = await send(push.url, {
      method: "PUT",
      headers: { ...headers, Filename: `${slot.date}-${slot.hour}.md`, Message: headline(markdown) },
      body: markdown,
    }).catch(() => undefined);
    if (attached?.ok) return undefined;
    const fallback = await send(push.url, { method: "POST", headers, body: truncateBytes(markdown, FALLBACK_BODY_BYTES) });
    return fallback.ok ? undefined : `push failed: HTTP ${fallback.status}`;
  } catch (error) {
    return `push failed: ${scrubbed(error, push.url)}`;
  }
}
