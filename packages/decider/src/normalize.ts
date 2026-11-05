/** One spelling for a category, initiative or phrase: lowercase, with every run of spaces, `-`, `_` or punctuation folded to `_`. */
export function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "");
}

/** The normalized key, or the trimmed lowercase text when normalizing would empty it, so a symbol-only name never collapses to "". */
export function categoryKey(text: string): string {
  return normalizeKey(text) || text.trim().toLowerCase();
}

/** The ledger's own fallback for a row with no category; a blank name lands here so the schema's non-empty category always holds. */
const FALLBACK_CATEGORY = "other";

/** The key a policy row, a threshold lookup and a score bucket use: `categoryKey`, or `other` for a blank name. */
export function policyCategory(text: string): string {
  return categoryKey(text) || FALLBACK_CATEGORY;
}
