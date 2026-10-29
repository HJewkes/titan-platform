import type { FakeGitHub } from "./fake-types.js";
import { BlobTooLargeError } from "./file-bytes.js";

/** Over `maxBytes` refuses before the copy, as the REST wire refuses before the blob read. */
function checkSize(bytes: Uint8Array, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && bytes.length > maxBytes) throw new BlobTooLargeError(bytes.length, maxBytes);
}

/** A copy, so a caller that writes into the answer cannot change what the fake serves next. */
export function fakeContentBytes(fake: FakeGitHub, path: string, ref: string, maxBytes?: number): Uint8Array | null {
  const key = `${ref}:${path}`;
  const stored = fake.bytes.get(key);
  if (stored) checkSize(stored, maxBytes);
  if (stored) return stored.slice();
  const text = fake.files.get(key);
  const encoded = text ? new TextEncoder().encode(text.content) : null;
  if (encoded) checkSize(encoded, maxBytes);
  return encoded;
}
