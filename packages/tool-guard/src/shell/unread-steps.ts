import type { Token, WordToken } from "./lexer.js";

const ASSIGNMENT_RE = /^[A-Za-z_]\w*(?:\[.*\])?\+?=/s;
/** Words that run the next word as a command, so a dynamic word after them may still name the command. */
const MODIFIERS = new Set(["!", "{", "(", "if", "then", "elif", "else", "do", "while", "until", "time", "command", "builtin", "exec", "nocorrect", "noglob", "coproc", "env", "nice", "nohup", "xargs"]);
/** Commands that change what a later word means: an alias, an option, a variable named by its operand, a file's content. */
const CHANGES_READING = new Set(["alias", "unalias", ".", "source", "shopt", "setopt", "unsetopt", "set", "emulate", "enable", "read", "declare", "typeset", "local", "readonly", "export", "printf", "eval"]);
/** Of those, the ones that matter only with an operand the guard cannot read; the rest always do. */
const NEEDS_DYNAMIC_OPERAND = new Set(["shopt", "setopt", "unsetopt", "set", "emulate", "enable", "read", "declare", "typeset", "local", "readonly", "export", "printf", "eval"]);

function unknown(w: WordToken): boolean {
  return w.dynamic || w.computed || w.spliced || w.refs.length > 0 || w.subs.length > 0;
}

function nestedLists(t: Token): Token[][] {
  if (t.type === "redirect") return [...(t.target?.subs ?? []), ...t.subs];
  return t.type === "word" || t.type === "subs" ? t.subs : [];
}

/** Whether a simple command's words leave the shell's state, or what a later word means, to something the guard cannot read. */
function commandUnread(words: WordToken[]): boolean {
  for (const [i, w] of words.entries()) {
    if (ASSIGNMENT_RE.test(w.value)) continue;
    if (unknown(w)) return true;
    if (MODIFIERS.has(w.value) || w.value.startsWith("-")) continue;
    if (!CHANGES_READING.has(w.value)) return false;
    return !NEEDS_DYNAMIC_OPERAND.has(w.value) || words.slice(i + 1).some(unknown);
  }
  return false;
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
