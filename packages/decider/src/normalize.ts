/** One spelling for a category, initiative or phrase: lowercase, with every run of spaces, `-`, `_` or punctuation folded to `_`. */
export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}
