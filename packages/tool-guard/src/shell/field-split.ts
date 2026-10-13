import { isCaseUnsureLookup } from "./case-attrs.js";
import type { CaseUnsure } from "./case-attrs.js";
import type { WordToken } from "./tokens.js";
import { ASSIGNMENT_RE, expandWord, lookup, PASS_THROUGH } from "./vars.js";
import type { Vars } from "./vars.js";

type Resolve = (name: string) => string | null | CaseUnsure;

/** Bash expands these builtins' assignment-shaped arguments as assignments, which never split. */
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
const DEFAULT_IFS = " \t\n";
const BLANKS_RE = /[ \t\n]+/;
const BLANK_RE = /[ \t\n]/;

/**
 * The command's words as bash reads them: a known value in an unquoted expansion is split on blanks and an
 * empty field is dropped. zsh does not split, so this is a reading beside the as-written one, never instead of
 * it. A word this cannot split exactly (mixed quoting, a custom IFS, a value a case attribute may change) is
 * left raw and dynamic, so it fails closed. Null when every word reads as `expandWord` gives it.
 */
export function splitReading(words: WordToken[], vars: Vars, home: string | null): WordToken[] | null {
  const resolve: Resolve = (name) => lookup(vars, home, name);
  const customIfs = vars.has("IFS") && lookup(vars, home, "IFS") !== DEFAULT_IFS;
  const kept = assignmentSlots(words);
  let changed = false;
  const reading = words.flatMap((word, i) => {
    const fields = kept.has(i) ? null : splitWord(word, resolve, customIfs);
    changed ||= fields !== null;
    return fields ?? [expandWord(word, resolve)];
  });
  return changed ? reading : null;
}

/** Indexes of the leading `NAME=value` words and of a declaration builtin's assignment-shaped arguments. */
function assignmentSlots(words: WordToken[]): Set<number> {
  const slots = new Set<number>();
  let i = 0;
  for (; i < words.length && ASSIGNMENT_RE.test((words[i] as WordToken).value); i++) slots.add(i);
  while (i < words.length && (PASS_THROUGH.has((words[i] as WordToken).value) || (words[i] as WordToken).value === "-p")) i++;
  const name = words[i];
  if (name === undefined || name.dynamic || !DECLARERS.has(name.value)) return slots;
  for (let j = i + 1; j < words.length; j++) if (ASSIGNMENT_RE.test((words[j] as WordToken).value)) slots.add(j);
  return slots;
}

/** The fields one word splits into, `[word]` when it must stay raw, or null when `expandWord` reads it exactly. */
function splitWord(word: WordToken, resolve: Resolve, customIfs: boolean): WordToken[] | null {
  if (!word.dynamic || word.computed || !word.unquotedExpansion || word.refs.length === 0) return null;
  const found = word.refs.map((ref) => resolve(ref.name));
  const values = found.map((f) => (isCaseUnsureLookup(f) ? f.asWritten : f));
  if (values.includes(null)) return null;
  if (customIfs) return [word];
  const expanded = expandWord(word, resolve);
  if (expanded.value !== "" && !values.some((v) => BLANK_RE.test(v as string))) return null;
  if (word.quoted || word.spliced || found.some(isCaseUnsureLookup)) return [word];
  const typed = word.typed ?? word.value;
  return fieldValues(word, values as string[]).map((value) => ({ ...expanded, value, dynamic: false, refs: [], typed }));
}

/** Literal text stays in its field; each value is split on blank runs, and empty fields are dropped. */
function fieldValues(word: WordToken, values: string[]): string[] {
  const fields: string[] = [];
  let current = "";
  let last = 0;
  for (const [i, ref] of word.refs.entries()) {
    const [first = "", ...rest] = (values[i] as string).split(BLANKS_RE);
    current += word.value.slice(last, ref.start) + first;
    for (const part of rest) {
      if (current !== "") fields.push(current);
      current = part;
    }
    last = ref.end;
  }
  current += word.value.slice(last);
  if (current !== "") fields.push(current);
  return fields;
}
