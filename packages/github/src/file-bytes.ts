import type { Rest } from "./rest.js";

interface ContentsEntry {
  type: string;
  sha: string;
  size: number;
  encoding?: string;
  content?: string;
}

/** A file whose reported size is over the caller's `maxBytes`, refused before its blob is downloaded. */
export class BlobTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`${size} bytes is over ${maxBytes} bytes`);
    this.name = "BlobTooLargeError";
  }
}

/**
 * The contents API inlines a file only up to 1 MB; past that it answers `encoding: "none"` with no content, so the
 * bytes come from `git/blobs/{sha}`, which serves blobs up to 100 MB. With `maxBytes`, the size the contents entry
 * reports is checked before that download, and a size that is not a number within the cap refuses. A decoded length
 * that is not the reported size throws rather than return a short file.
 */
export async function readContentBytes(api: Rest, repo: string, path: string, ref: string, maxBytes?: number): Promise<Uint8Array | null> {
  const entry = await api.getOrNull<ContentsEntry | ContentsEntry[]>(`repos/${repo}/contents/${path}`, { ref });
  if (!entry) return null;
  if (Array.isArray(entry) || entry.type !== "file") throw new Error(`${path} at ${ref} is not a file`);
  if (maxBytes !== undefined && !(entry.size <= maxBytes)) throw new BlobTooLargeError(entry.size, maxBytes);
  const inline = entry.encoding === "base64" && entry.content ? entry.content : await blobBase64(api, repo, entry.sha);
  const bytes = new Uint8Array(Buffer.from(inline, "base64"));
  if (bytes.length !== entry.size) throw new Error(`${path} at ${ref} decoded to ${bytes.length} bytes, GitHub reported ${entry.size}`);
  return bytes;
}

/** Read through `text`, which keeps no ETag cache: a cached multi-megabyte blob body would outlive every caller. */
async function blobBase64(api: Rest, repo: string, sha: string): Promise<string> {
  const blob: unknown = JSON.parse(await api.text(`repos/${repo}/git/blobs/${sha}`));
  if (typeof blob === "object" && blob !== null && "encoding" in blob && blob.encoding === "base64" && "content" in blob && typeof blob.content === "string") return blob.content;
  throw new Error(`blob ${sha} answered no base64 content`);
}
