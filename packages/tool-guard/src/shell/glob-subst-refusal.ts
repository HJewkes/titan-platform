import { assignOnExpand } from "./assign-on-expand.js";
import { ParseError, tokenize } from "./lexer.js";
import type { WordToken } from "./lexer.js";
import { literalValue } from "./literal-word.js";
import { SHELLS } from "./inline-script.js";
import { unwrap } from "./unwrap.js";
import { writesProtectedParam } from "./hooked-params.js";
import { namesGlobSubstOption } from "./glob-subst.js";
import { ReadingLimitError } from "./unsure-readings.js";
import type { Unwrapped } from "./unwrap.js";

/**
 * Parameters a store into turns GLOB_SUBST on: zsh's `options` array, and `ARGV0`, which a later `zsh` reads as the name
 * it was started under (`sh` and `ksh` emulate, with GLOB_SUBST on).
 */
const OPTIONS: ReadonlySet<string> = new Set(["options", "ARGV0"]);

/** Builtins and shells `namesGlobSubstOption` reads; a wrapper reading of one decides the line even when the classifier ignores its name. */
export const GLOB_SUBST_READERS: ReadonlySet<string> = new Set(["setopt", "unsetopt", "set", "emulate", "zsh"]);

/** A line that may turn on zsh GLOB_SUBST, under which an unquoted `$x` holding `*(e:CODE:)` runs CODE; the hook denies it unchecked. */
export class GlobSubstError extends ReadingLimitError {
  constructor() {
    super();
    this.message = "a command that may turn on zsh GLOB_SUBST";
    this.name = "GlobSubstError";
  }
}

/**
 * Whether the command names the option, or stores into `options` or `ARGV0`; either reading of an unreadable word counts.
 * A command word only known at run time may be a wrapper (`env -S`) that splits a string into the real command, so
 * every blank-holding argument is read as shell text too.
 */
function mayEnableGlobSubst(cmd: Unwrapped): boolean {
  return (
    namesOption(asZsh(cmd)) ||
    storesOption(cmd) ||
    cmd.args.some((arg) => arg.dynamic && assignOnExpand(arg.value, OPTIONS) !== null) ||
    (cmd.name === null && cmd.args.some(namesInString))
  );
}

/** A shell's or `eval`'s text is walked as commands of its own, where its stores are read. */
function storesOption(cmd: Unwrapped): boolean {
  const runsText = cmd.name !== null && (SHELLS.has(cmd.name) || cmd.name === "eval");
  return !runsText && writesProtectedParam(cmd, cmd.args, [], OPTIONS) !== null;
}

/**
 * D3: a dynamic command word refuses only with an unknowable argument. When every other word is literal, the word is
 * read as dropped (`$SUDO ./install.sh` runs the script) and as a wrapper whose arguments an option reader gets.
 */
function namesOption(cmd: Unwrapped): boolean {
  const [, ...rest] = cmd.args;
  if (cmd.name !== null || cmd.args.length === 0 || !rest.every((w) => literalValue(w) !== null)) return namesGlobSubstOption(cmd);
  const named = (name: string, args: WordToken[]): Unwrapped => ({ ...cmd, name, path: name, args });
  const dropped = rest[0] === undefined ? [] : [named(literalValue(rest[0]) ?? "", rest.slice(1))];
  return [...[...GLOB_SUBST_READERS].map((name) => named(name, rest)), ...dropped].some(namesGlobSubstOption);
}

/** A versioned or renamed zsh binary (`zsh-5.9`, `zsh-static`) reads its options like zsh. */
function asZsh(cmd: Unwrapped): Unwrapped {
  return cmd.name !== null && cmd.name !== "zsh" && /^zsh[-_.\w]*$/.test(cmd.name) ? { ...cmd, name: "zsh" } : cmd;
}

function namesInString(arg: WordToken): boolean {
  const text = literalValue(arg);
  return text !== null && /\s/.test(text) && commandsIn(text).some((words) => {
    const inner = unwrap(words);
    return inner !== null && mayEnableGlobSubst(inner);
  });
}

/** The words of each command in the text; text the lexer rejects is no command string. */
function commandsIn(text: string): WordToken[][] {
  try {
    const lists: WordToken[][] = [[]];
    for (const token of tokenize(text)) {
      if (token.type === "op") lists.push([]);
      else if (token.type === "word") lists.at(-1)?.push(token);
    }
    return lists.filter((words) => words.length > 0);
  } catch (error) {
    if (error instanceof ParseError) return [];
    throw error;
  }
}

/** Throws `GlobSubstError` when the command may enable GLOB_SUBST. */
export function refuseGlobSubst(cmd: Unwrapped): void {
  if (mayEnableGlobSubst(cmd)) throw new GlobSubstError();
}
