import type { Token, WordToken } from "./lexer.js";

const ASSIGNMENT_RE = /^[A-Za-z_]\w*(?:\[.*\])?\+?=/s;
/** Words that run the next word as a command, so a dynamic word after them may still name the command. */
const MODIFIERS = new Set(["!", "{", "(", "if", "then", "elif", "else", "do", "while", "until", "time", "command", "builtin", "exec", "nocorrect", "noglob", "coproc", "env", "nice", "nohup", "xargs"]);
/** Commands that change what a later word means: an alias, an option, a variable named by its operand, a file's content. */
const CHANGES_READING = new Set(["alias", "unalias", ".", "source", "shopt", "setopt", "unsetopt", "set", "emulate", "enable", "disable", "read", "declare", "typeset", "local", "readonly", "export", "printf", "eval", "trap", "mapfile", "readarray"]);
/** Of those, the ones that matter only with an operand the guard cannot read; the rest always do: `enable` and `disable`, and the ones that run text or a callback in this shell later (`eval`, `trap`, `mapfile -C`), whose static string may define an alias for a later line. */
const NEEDS_DYNAMIC_OPERAND = new Set(["shopt", "setopt", "unsetopt", "set", "emulate", "read", "declare", "typeset", "local", "readonly", "export", "printf"]);

function unknown(w: WordToken): boolean {
  return w.dynamic || w.computed || w.spliced || w.refs.length > 0 || w.subs.length > 0;
}

function nestedLists(t: Token): Token[][] {
  if (t.type === "redirect") return [...(t.target?.subs ?? []), ...t.subs];
  return t.type === "word" || t.type === "subs" ? t.subs : [];
}

/** Whether a simple command's words leave the shell's state, or what a later word means, to something the guard cannot read. */
function leadingUnread(words: WordToken[]): boolean {
  for (const [i, w] of words.entries()) {
    if (ASSIGNMENT_RE.test(w.value)) continue;
    if (unknown(w)) return true;
    if (MODIFIERS.has(w.value) || w.value.startsWith("-")) continue;
    if (!CHANGES_READING.has(w.value)) return false;
    return !NEEDS_DYNAMIC_OPERAND.has(w.value) || words.slice(i + 1).some(unknown);
  }
  return false;
}

/** Words that read a file by name, so they matter only where a command can start; as an argument (`ls .`) they are plain. */
const READS_FILE = new Set([".", "source"]);

/** Whether the word at `i` is a reading-changing command anywhere in the group, not only its first word: a keyword or brace body (`function f { eval ...; }`, `do trap ...`) starts a command mid-group. */
function changesReadingAt(words: WordToken[], i: number, w: WordToken): boolean {
  if (!CHANGES_READING.has(w.value)) return false;
  const before = words[i - 1];
  const startsCommand = before === undefined || ASSIGNMENT_RE.test(before.value) || MODIFIERS.has(before.value);
  if (READS_FILE.has(w.value) && !startsCommand) return false;
  return !NEEDS_DYNAMIC_OPERAND.has(w.value) || words.slice(i + 1).some(unknown);
}

/** A group of words is unread when its leading command is, or any word in it is a reading-changing command: failing closed beats listing the keywords that open a body. */
function commandUnread(words: WordToken[]): boolean {
  return leadingUnread(words) || words.some((w, i) => changesReadingAt(words, i, w));
}

/**
 * Whether anything on the line (substitutions included) is a step the guard cannot read: a command word that is
 * expanded or spelled by quotes, an alias or option or file-sourcing command, or a store or option set through a
 * dynamic operand. Any such step may have renamed `[[` before it, so no `[[` after it may join its operators.
 */
export function hasUnreadSteps(tokens: Token[]): boolean {
  let words: WordToken[] = [];
  for (const t of tokens) {
    if (nestedLists(t).some(hasUnreadSteps)) return true;
    if (t.type === "word") words.push(t);
    else if (t.type === "op" && commandUnread(words)) return true;
    if (t.type === "op") words = [];
  }
  return commandUnread(words);
}
