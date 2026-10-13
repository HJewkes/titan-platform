import { isCaseUnsure } from "../shell/case-attrs.js";
import type { WordToken } from "../shell/lexer.js";

/**
 * gh's own `-F` placeholder pattern (gh 2.102), unanchored as gh applies it: `{branch}` and `:branch` become the
 * checked-out branch, so `m:branch` or `feature-{branch}` names a branch only known at run time.
 */
export const GH_PLACEHOLDER_RE = /:(?:owner|repo|branch)\b|\{[a-z]+\}/;
/** The matches gh fills; it leaves any other `{name}`, such as a `{oid}` selection, as written. */
const GH_FILLED = new Set([":owner", ":repo", ":branch", "{owner}", "{repo}", "{branch}"]);
const GLOB_RE = /[*?[]/;
const BRACE_LIST_RE = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;

export const ghFills = (text: string) => [...text.matchAll(new RegExp(GH_PLACEHOLDER_RE, "g"))].filter((m) => GH_FILLED.has(m[0]));

/** A field key that is `key` itself, or has `key` as any bracket segment of gh's nested `a[b][key]` form. */
const fieldKeyRe = (key: string) => new RegExp(`^(?:${key}|.*\\[${key}\\])$`);

const keyEnd = (text: string) => (text.includes("=") ? text.indexOf("=") : text.length);

/**
 * Whether pathname or brace expansion may rewrite the word: a glob character or brace list not wholly inside one pair
 * of quotes. The lexer keeps no record of which characters partial quotes or escapes cover, so those count as bare.
 */
function expandsAtRunTime(word: WordToken): boolean {
  if (word.quoted && !word.spliced) return false;
  return GLOB_RE.test(word.value) || BRACE_LIST_RE.test(word.value);
}

/**
 * A field word's key, the text before its first `=`, or null when the shell may change it at run time: a variable or
 * command substitution at or before that `=` (`query$(printf x)=v` sends the key `queryx`), an expansion the word
 * was resolved from, a glob or brace list, a case attribute, or a dynamic part no ref or cut accounts for.
 */
export function literalKey(word: WordToken): string | null {
  const end = keyEnd(word.value);
  const cuts = word.cuts ?? [];
  if (word.refs.some((r) => r.start <= end) || cuts.some((c) => c.at <= end)) return null;
  if (word.dynamic && word.refs.length + cuts.length === 0) return null;
  if (word.typed !== undefined && /[$`]/.test(word.typed.slice(0, keyEnd(word.typed)))) return null;
  return isCaseUnsure(word) || expandsAtRunTime(word) ? null : word.value.slice(0, end);
}

/** Whether a field word's key is `key`, or a nested `a[b][key]`; null when the key is unknown until run time. */
export function fieldKeyed(word: WordToken, key: string): boolean | null {
  const name = literalKey(word);
  return name === null ? null : fieldKeyRe(key).test(name);
}

export function fieldValue(word: WordToken): string {
  return word.value.slice(keyEnd(word.value) + 1);
}

/** A field whose value cannot be read: computed at run time, case-folded, expanded, read from a file, or filled by gh. */
export function unreadable(word: WordToken): boolean {
  if (word.dynamic || isCaseUnsure(word) || expandsAtRunTime(word)) return true;
  return fieldValue(word).startsWith("@") || ghFills(word.value).length > 0;
}
