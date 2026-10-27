import type { FakeGitHub } from "./fake-types.js";

/** A copy, so a caller that writes into the answer cannot change what the fake serves next. */
export function fakeContentBytes(fake: FakeGitHub, path: string, ref: string): Uint8Array | null {
  const key = `${ref}:${path}`;
  const stored = fake.bytes.get(key);
  if (stored) return stored.slice();
  const text = fake.files.get(key);
  return text ? new TextEncoder().encode(text.content) : null;
}
