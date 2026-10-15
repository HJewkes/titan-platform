import { isCaseUnsureLookup } from "./case-attrs.js";
import type { CaseUnsure } from "./case-attrs.js";
import { hasIfsChar, ifsFields } from "./ifs-fields.js";
import type { WordPart } from "./ifs-fields.js";
import type { WordToken } from "./tokens.js";
import { ASSIGNMENT_RE, expandWord, lookup } from "./vars.js";
import type { Vars } from "./vars.js";

type Resolve = (name: string) => string | null | CaseUnsure;

/** Bash expands these builtins' assignment-shaped arguments as assignments, which never split. */
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
const DEFAULT_IFS = " \t\n";

/**
 * The command's words as bash reads them: a known value in an unquoted expansion is split on the known IFS
 * as bash 5 splits it. zsh does not split, so this is a reading beside the as-written one, never instead of
 * it. A word this cannot split exactly (mixed quoting, an unknown or unmodelled IFS, a value a case attribute
 * may change) is left raw and dynamic, so it fails closed. Null when every word reads as `expandWord` gives it.
 */
export function splitReading(words: WordToken[], vars: Vars, home: string | null): WordToken[] | null {
  const resolve: Resolve = (name) => lookup(vars, home, name);
  const ifs = knownIfs(vars, home);
  const kept = assignmentSlots(words);
  const split = words.map((word, i) => (kept.has(i) ? null : splitWord(word, resolve, ifs)));
  if (split.every((fields) => fields === null)) return null;
  return words.flatMap((word, i) => split[i] ?? [expandWord(word, resolve)]);
}

/** IFS as the walk holds it: the default when never assigned, null when unknown or a case attribute may change it. */
function knownIfs(vars: Vars, home: string | null): string | null {
  if (!vars.has("IFS")) return DEFAULT_IFS;
  const ifs = lookup(vars, home, "IFS");
  return typeof ifs === "string" ? ifs : null;
}

/**
 * Indexes of the leading `NAME=value` words and of a declaration builtin's assignment-shaped arguments. Bash
 * keeps a declaration's value whole only when the declarer is an unquoted word, bare or behind `time`;
 * behind `command` or `builtin`, or spelled `\export`, its arguments are ordinary words and split.
 */
function assignmentSlots(words: WordToken[]): Set<number> {
  const slots = new Set<number>();
  let i = 0;
  while (i < words.length && ASSIGNMENT_RE.test(words[i]?.value ?? "")) slots.add(i++);
  if (words[i]?.value === "time" && !words[i]?.quoted) i += words[i + 1]?.value === "-p" ? 2 : 1;
  const name = words[i];
  if (name === undefined || name.dynamic || name.quoted || !DECLARERS.has(name.value)) return slots;
  words.forEach((word, j) => {
    if (j > i && ASSIGNMENT_RE.test(word.value)) slots.add(j);
  });
  return slots;
}

/** The fields one word splits into, `[word]` when it must stay raw, or null when `expandWord` reads it exactly. */
function splitWord(word: WordToken, resolve: Resolve, ifs: string | null): WordToken[] | null {
  if (!word.dynamic || word.computed || !word.unquotedExpansion || word.refs.length === 0) return null;
  const found = word.refs.map((ref) => resolve(ref.name));
  const values = found.map((f) => (isCaseUnsureLookup(f) ? f.asWritten : f));
  if (!values.every((v): v is string => v !== null)) return null;
  if (ifs === null) return [word];
  const expanded = expandWord(word, resolve);
  if (expanded.value !== "" && !values.some((v) => hasIfsChar(v, ifs))) return null;
  if (word.quoted || word.spliced || found.some(isCaseUnsureLookup)) return [word];
  const fields = ifsFields(wordParts(word, values), ifs);
  if (fields === null) return [word];
  const typed = word.typed ?? word.value;
  return fields.map((value) => ({ ...expanded, value, dynamic: false, refs: [], typed }));
}

/** The word as literal slices, which never split, and its refs' values, which do. */
function wordParts(word: WordToken, values: string[]): WordPart[] {
  const parts: WordPart[] = [];
  let last = 0;
  for (const [i, ref] of word.refs.entries()) {
    parts.push({ text: word.value.slice(last, ref.start), splits: false }, { text: values[i] ?? "", splits: true });
    last = ref.end;
  }
  parts.push({ text: word.value.slice(last), splits: false });
  return parts;
}
