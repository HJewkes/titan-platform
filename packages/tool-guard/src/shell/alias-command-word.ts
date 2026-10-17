import { BRACE_RE } from "./word-generation.js";
import { WRITER_SPECS } from "./writer-specs.js";

/**
 * A glob in a command word, which may match several file names: a bracket only with its closing one, so `[` and `[[`
 * stay themselves, and a tilde only past the first character, where it is extendedglob's exclusion.
 */
const SEVERAL_NAMES_RE = /[*?#^]|.~/s;
const hasBracketGlob = (path: string): boolean => path.indexOf("]", path.indexOf("[") + 1) !== -1 && path.includes("[");
/** The comparison words of `[[ $a == b ]]`, which a run-time command word reads as its operands but name no file. */
export const TEST_OPERATOR_RE = /^(?:==?|!=|=~)$/;

/**
 * Whether a static command word the shell still expands may be `alias`: false for a path or a comparison operator, a
 * brace expansion or a glob that cannot yield one, true for one that may; null for a word with neither (a leading `~`
 * or `=` is the caller's).
 */
export function expandedWordMayBeAlias(path: string, storeBuiltins: Iterable<string> = []): boolean | null {
  if (hasPathSlash(path) || TEST_OPERATOR_RE.test(path)) return false;
  if (BRACE_RE.test(path)) return bracesMayBeAlias(path);
  if (SEVERAL_NAMES_RE.test(path) || hasBracketGlob(path)) return globMayBeAlias(path, storeBuiltins);
  return null;
}

/** Glob syntax the matcher below does not model: negation, exclusion, repetition, number ranges, classes, groups. */
const UNMODELLED_GLOB_RE = /\^|.~|#|<\d*-\d*>|\[:|[*?+@!]\(|\(#|\(.*\||\\|\[[!^]?\]/s;
/** Characters that give a space in a glob a meaning beyond itself: `alias\ #` is `alias` under extendedglob. */
const SPACE_NEUTRAL_RE = /[\^~<[#(|\\]/;
/** Command words that are `alias`, run their operands as a command, or store into an alias parameter or table. */
const ALIAS_REACHERS = [
  "alias", "builtin", "command", "noglob", "nocorrect", "exec", "time", "eval", "env", "nice", "nohup", "sudo",
  "enable", "source", ".", ...Object.keys(WRITER_SPECS),
];

/** A `/` outside braces and brackets: whatever the word expands to is a path, never the `alias` builtin. */
function hasPathSlash(path: string): boolean {
  let open = 0;
  for (const c of path) {
    if (c === "{" || c === "[") open++;
    else if ((c === "}" || c === "]") && open > 0) open--;
    else if (c === "/" && open === 0) return true;
  }
  return false;
}

/** A brace sequence, `{a..e}` or `{1..3}`. */
const SEQUENCE_RE = /^[^,{}]*\.\.[^,{}]*$/;

/**
 * Whether a word with braces may expand to a word that is `alias`: text outside the braces stays in every word, so a
 * character that is no letter or glob character rules it out (`ab:{x,y}`), and a group needs one alternative that
 * may be one (`{"a":1,"b":2}`). A group with no comma is a sequence, which may give any letter, or else literal text.
 */
function bracesMayBeAlias(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (c !== "{") {
      if (!/[A-Za-z*?[\]^#~]/.test(c)) return false;
      continue;
    }
    const end = groupEnd(text, i);
    if (end === -1) return false;
    const body = text.slice(i + 1, end);
    if (!(SEQUENCE_RE.test(body) || alternatives(body).some(bracesMayBeAlias))) return false;
    i = end;
  }
  return true;
}

/** The index of the `}` closing the `{` at `at`, or -1. */
function groupEnd(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** The top-level comma-separated parts of a group's body; none for a body that has no top-level comma. */
function alternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") depth--;
    else if (body[i] === "," && depth === 0) {
      parts.push(body.slice(from, i));
      from = i + 1;
    }
  }
  return parts.length === 0 ? [] : [...parts, body.slice(from)];
}

/**
 * Whether a glob command word may be `alias`, a wrapper that runs it, or a builtin that stores into an alias table: it
 * expands to the names of existing files, so only one that matches such a name can. Syntax not modelled counts as
 * matching, and the match ignores case because nocaseglob lets `ALI*` match a file named `alias`.
 */
function globMayBeAlias(pattern: string, storeBuiltins: Iterable<string>): boolean {
  if (/\s/.test(pattern) && !SPACE_NEUTRAL_RE.test(pattern)) return false;
  if (UNMODELLED_GLOB_RE.test(pattern)) return true;
  const source = pattern.replace(/[.+${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".").replace(/\[!/g, "[^");
  try {
    const matcher = new RegExp(`^${source}$`, "si");
    return [...ALIAS_REACHERS, ...storeBuiltins].some((name) => matcher.test(name));
  } catch {
    return true;
  }
}
