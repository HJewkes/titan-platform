import type { WordToken } from "./lexer.js";
import { ReadingLimitError } from "./unsure-readings.js";
import type { Unwrapped } from "./unwrap.js";

/** Parameters whose stores bind a command name, or a `~name`, to something the guard never reads as that name. */
const REBINDING = "commands|BASH_CMDS|functions|dis_functions|nameddirs";
/** A parameter named as a declaration or `read` operand: `commands`, `commands[y]=…`, `functions+=…`. */
const STORED_RE = new RegExp(`^(?:${REBINDING})(?:\\[|\\+?=|$)`);
/** An expansion that assigns: `${commands[y]::=/x}`, `${functions[y]:=x}`, bash `${BASH_CMDS[y]=/x}`; a read has no `=`. */
const ASSIGNING_EXPANSION_RE = new RegExp(`\\$\\{[^}]*?\\b(?:${REBINDING})(?:\\[[^\\]]*\\])?:{0,2}=`);
/** Builtins that store into a parameter named by an operand or an option value. */
const STORERS = new Set([
  "typeset", "declare", "local", "export", "readonly", "integer", "float",
  "set", "read", "print", "printf", "zparseopts", "vared", "getopts",
]);

/** A line that rebinds a command name (`hash y=/usr/bin/git`, `commands[y]=…`); the hook denies it unchecked. */
export class CommandRebindingError extends ReadingLimitError {
  constructor() {
    super();
    this.message = "a command that rebinds a command name";
    this.name = "CommandRebindingError";
  }
}

/**
 * Whether the command binds a command name to another program or text for the rest of the line: zsh `hash NAME=PATH`,
 * bash `hash -p PATH NAME`, or a store into one of the parameters zsh and bash look commands up in. Listing, looking up,
 * resetting or removing a binding (`hash git`, `hash -r`, `unhash y`) falls back to the PATH lookup the guard reads.
 */
export function rebindsCommand(cmd: Unwrapped): boolean {
  if (cmd.name === "hash" && hashBinds(cmd.args)) return true;
  if (cmd.assigned.some(([name]) => STORED_RE.test(name))) return true;
  if (cmd.name !== null && STORERS.has(cmd.name) && cmd.args.some((a) => STORED_RE.test(a.value))) return true;
  const texts = [...cmd.args.flatMap((a) => [a.value, a.typed ?? ""]), ...cmd.assigned.map(([, value]) => value ?? "")];
  return texts.some((text) => ASSIGNING_EXPANSION_RE.test(text));
}

/** An operand holding `=`, an option cluster holding bash's `p`, or a word that may expand to either. */
function hashBinds(args: WordToken[]): boolean {
  let options = true;
  for (const arg of args) {
    if (arg.dynamic) return true;
    if (options && arg.value === "--") options = false;
    else if (options && /^-[^-]/s.test(arg.value)) {
      if (arg.value.includes("p")) return true;
    } else {
      options = false;
      if (arg.value.includes("=")) return true;
    }
  }
  return false;
}
