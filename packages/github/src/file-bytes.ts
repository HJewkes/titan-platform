import type { Rest } from "./rest.js";

interface ContentsEntry {
  type: string;
  sha: string;
  size: number;
  encoding?: string;
  content?: string;
}

interface Blob {
  encoding: string;
  content: string;
}

/**
 * The contents API inlines a file only up to 1 MB; past that it answers `encoding: "none"` with no content, so the
 * bytes come from `git/blobs/{sha}`, which serves blobs up to 100 MB. A decoded length that is not the reported size
 * throws rather than return a short file.
 */
export async function readContentBytes(api: Rest, repo: string, path: string, ref: string): Promise<Uint8Array | null> {
  const entry = await api.getOrNull<ContentsEntry | ContentsEntry[]>(`repos/${repo}/contents/${path}`, { ref });
  if (!entry) return null;
  if (Array.isArray(entry) || entry.type !== "file") throw new Error(`${path} at ${ref} is not a file`);
  const inline = entry.encoding === "base64" && entry.content ? entry.content : await blobBase64(api, repo, entry.sha);
  const bytes = new Uint8Array(Buffer.from(inline, "base64"));
  if (bytes.length !== entry.size) throw new Error(`${path} at ${ref} decoded to ${bytes.length} bytes, GitHub reported ${entry.size}`);
  return bytes;
}

/** Read through `text`, which keeps no ETag cache: a cached multi-megabyte blob body would outlive every caller. */
async function blobBase64(api: Rest, repo: string, sha: string): Promise<string> {
  const blob = JSON.parse(await api.text(`repos/${repo}/git/blobs/${sha}`)) as Blob;
  if (blob.encoding !== "base64") throw new Error(`blob ${sha} is ${blob.encoding}-encoded, not base64`);
  return blob.content;
}
