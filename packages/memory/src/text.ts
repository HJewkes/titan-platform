import { contentHashOf } from "@titan-design/store-sqlite";

const TOKEN = /[a-z0-9_]+/g;
const NEGATION = /\b(never|don'?t|do not|avoid|not|no|stop|without)\b/i;

/** Lowercase alphanumeric tokens of two or more characters, as a set. */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.toLowerCase().matchAll(TOKEN)) if (match[0].length >= 2) out.add(match[0]);
  return out;
}

/** Case- and whitespace-insensitive form used for exact-duplicate detection. */
export function normalizeContent(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function contentKey(text: string): string {
  return contentHashOf(normalizeContent(text));
}

export function jaccard(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** Whether a rule is phrased as a prohibition; used only to flag likely conflicts, never to block. */
export function isNegated(text: string): boolean {
  return NEGATION.test(text);
}
