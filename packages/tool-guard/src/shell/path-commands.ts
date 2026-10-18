import { COMMAND_PREFIXES } from "./compound.js";
import type { Token, WordToken } from "./lexer.js";
import { NAMEREF_DECLARERS } from "./name-slots.js";
import { NUMERIC_COMMANDS, numericOutput } from "./numeric-output.js";

/** Words of a line on which nothing rebinds a command name, so `wc` or `date` there is the program found on PATH. */
const pathWords = new WeakSet<WordToken>();

/** Whether the word sits on a line where the commands it names are surely the programs on PATH. */
export const onPathLine = (w: WordToken) => pathWords.has(w);

/** Carries the mark to a copy of the word, as expanding a variable into it makes. */
export function carryPathLine(from: WordToken, to: WordToken): void {
  if (pathWords.has(from)) pathWords.add(to);
}

/** Commands that bind or define a name, or run text that may; any of them, or a function named like a numeric command, rules out PATH. */
const BINDERS = new Set(["alias", "hash", "eval", "source", ".", "enable", "functions", "autoload", "compdef"]);
/** Wrappers that run the next command in this shell, past the keywords that already leave command position open. */
const WRAPPERS = new Set(["builtin", "command", "exec", "noglob", "nocorrect"]);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const PATH_ASSIGNMENT_RE = /^(PATH|path|BASH_CMDS|commands)(\[[^\]]*\])?\+?=/;

/**
 * Marks every word of the line, substitutions included, when no function, alias, `hash` binding, `PATH` change or
 * run-time text on the line can rebind a command `numericOutput` reads. Fails closed: any doubt leaves the words unmarked.
 */
export function notePathLine(tokens: Token[]): Token[] {
  const words: WordToken[] = [];
  if (!rebindsAny(tokens, words)) for (const w of words) pathWords.add(w);
  return tokens;
}

function rebindsAny(tokens: Token[], words: WordToken[]): boolean {
  let start = true;
  let wrapped = false;
  let found = false;
  for (const [i, t] of tokens.entries()) {
    if (t.type === "redirect") found = subsRebind(t.target?.subs ?? [], words) || found;
    else if (t.type === "subs") found = subsRebind(t.subs, words) || found;
    else if (t.type === "op") {
      const next = tokens[i + 1];
      if (t.value === "(" && next?.type === "op" && next.value === ")") found ||= namesNumeric(tokens[i - 1]);
      [start, wrapped] = [t.value !== ")", false];
    } else {
      words.push(t);
      found = subsRebind(t.subs, words) || wordRebinds(t, tokens, i, start) || found;
      if (start && ASSIGNMENT_RE.test(t.value)) continue;
      // A word only digits may fill names no command, and may expand to nothing, so the next word may be the command.
      const keeps: boolean = start && (COMMAND_PREFIXES.has(t.value) || WRAPPERS.has(t.value) || (wrapped && /^-/.test(t.value)) || onlyDigits(t));
      [start, wrapped] = [keeps, keeps];
    }
  }
  return found;
}

function subsRebind(subs: Token[][], words: WordToken[]): boolean {
  let found = false;
  for (const sub of subs) found = rebindsAny(sub, words) || found;
  return found;
}

/** Whether the word at TOKENS[i] rebinds a name itself: a PATH change, or a binder or nameref declarer in command position. */
function wordRebinds(t: WordToken, tokens: Token[], i: number, start: boolean): boolean {
  if (PATH_ASSIGNMENT_RE.test(t.value)) return true;
  if (t.value === "function" && namesNumeric(tokens[i + 1])) return true;
  if (!start || ASSIGNMENT_RE.test(t.value)) return false;
  return (t.dynamic && !onlyDigits(t)) || BINDERS.has(t.value) || declaresNameref(t.value, tokens, i + 1);
}

/**
 * A run-time word whose only expansions are substitutions that print digits, around digits or a base's `#`:
 * `$(ls | wc -l)` or `10#$(date +%H)`, as the `$( ( … ) )` reading of a `$(( ))` runs them. If the line rebinds
 * a command those substitutions run, another word of it says so.
 */
function onlyDigits(t: WordToken): boolean {
  const cuts = t.cuts ?? [];
  const printsDigits = cuts.length > 0 && cuts.every((cut) => numericOutput(t.subs[cut.sub] ?? []));
  return t.dynamic && t.refs.length === 0 && /^[\d#]*$/.test(t.value) && printsDigits;
}

const namesNumeric = (t: Token | undefined) => t?.type === "word" && (NUMERIC_COMMANDS.has(t.value) || t.dynamic || t.quoted || t.spliced);

/**
 * A nameref may make `PATH` writable under another name (`declare -n r=PATH; r=/tmp/x`), so a declarer that may carry
 * `-n` voids the mark: a literal cluster holding `n`, or a word that may expand to an option.
 */
function declaresNameref(name: string, tokens: Token[], from: number): boolean {
  if (!NAMEREF_DECLARERS.has(name)) return false;
  for (let j = from; j < tokens.length; j++) {
    const t = tokens[j];
    if (t === undefined || t.type === "op") return false;
    if (t.type === "word" && mayBeNamerefOption(t)) return true;
  }
  return false;
}

const mayBeNamerefOption = (a: WordToken) =>
  /^[-+][A-Za-z0-9]*n/.test(a.value) || (a.dynamic && (/^[$`]/.test(a.value) || (a.cuts ?? []).some((c) => c.at === 0)));
