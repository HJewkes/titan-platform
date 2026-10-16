import { splitCluster } from "./cluster.js";
import { writesProtectedParam } from "./hooked-params.js";
import type { WordToken } from "./lexer.js";
import { ReadingLimitError } from "./unsure-readings.js";
import type { Unwrapped } from "./unwrap.js";

/** Parameters whose stores bind a command name, or a `~name`, to something the guard never reads as that name. */
const REBINDING = ["commands", "BASH_CMDS", "functions", "dis_functions", "nameddirs"];
const REBINDING_SET = new Set(REBINDING);
/** An expansion that assigns: `${commands[y]::=/x}`, `${functions[y]:=x}`, bash `${BASH_CMDS[y]=/x}`; a read has no `=`. */
const ASSIGNING_EXPANSION_RE = new RegExp(`\\$\\{[^}]*?\\b(?:${REBINDING.join("|")})(?:\\[[^\\]]*\\])?:{0,2}=`);
/** An expansion that assigns whatever parameter another one names: bash `${!n=/x}`, zsh `${(P)n::=/x}`. */
const INDIRECT_ASSIGNING_RE = /\$\{(?:!|\([^)]*P[^)]*\))[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?:{0,2}=/;
/** Builtins that skip one leading `--` and still read options after it: `zparseopts -- -A commands y:`. */
const SKIPS_LEADING_DASHES = new Set(["zparseopts", "zstyle", "zformat", "getopts"]);
const NAMEREF_DECLARERS = new Set(["typeset", "declare", "local"]);

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
 * bash `hash -p PATH NAME`, or a store into one of the parameters zsh and bash look commands up in. A store whose target
 * is only known at run time, or goes through a nameref or an indirect expansion, may be one, so it counts too. Listing,
 * looking up, resetting or removing a binding (`hash git`, `hash -r`, `unhash y`) falls back to the PATH lookup the guard reads.
 */
export function rebindsCommand(cmd: Unwrapped): boolean {
  if (cmd.name === "hash" && hashBinds(cmd.args)) return true;
  if (cmd.assigned.some(([name]) => REBINDING_SET.has(name))) return true;
  if (cmd.name !== null && storesRebinding(cmd, cmd.name)) return true;
  const texts = [...cmd.args.map((a) => a.value), ...cmd.assigned.map(([, value]) => value ?? "")];
  return texts.some((text) => ASSIGNING_EXPANSION_RE.test(text) || INDIRECT_ASSIGNING_RE.test(text));
}

/** An operand holding `=`, an option cluster holding bash's `p`, or a word that may expand to either. */
function hashBinds(args: WordToken[]): boolean {
  let options = true;
  for (const arg of args) {
    if (arg.dynamic) return true;
    if (options && /^-[^-]/s.test(arg.value)) {
      if (arg.value.includes("p")) return true;
    } else {
      options = false;
      if (arg.value.includes("=")) return true;
    }
  }
  return false;
}

/** Whether a command declares a nameref, copies a function under a new name, or stores into a rebinding parameter. */
function storesRebinding(cmd: Unwrapped, name: string): boolean {
  const declarer = NAMEREF_DECLARERS.has(name);
  if (declarer && cmd.args.some((a) => /^-[^-]*n/s.test(a.value) || /^[-+].*[^-+A-Za-z0-9]/s.test(a.value))) return true;
  if (name === "functions" && functionsCopies(cmd.args)) return true;
  const args = readableArgs(name, cmd.args, declarer);
  return writesProtectedParam({ ...cmd, args }, args, [], REBINDING_SET) !== null;
}

/**
 * The words the store reader gets: zsh skips one leading `--` before these builtins' options, and a lone quoted word
 * that follows `-f` (a function to print) or is all `printf` has (a format, which needs a word after it to be `-vNAME`)
 * stores nowhere.
 */
function readableArgs(name: string, args: WordToken[], declarer: boolean): WordToken[] {
  if (SKIPS_LEADING_DASHES.has(name) && args[0]?.value === "--") return args.slice(1);
  const last = args.at(-1);
  const quotedLast = last?.dynamic === true && last.unquotedExpansion !== true;
  const printsFunction = declarer && args.slice(0, -1).some((a) => /^-[^-]*f/s.test(a.value));
  return quotedLast && (printsFunction || (name === "printf" && args.length === 1)) ? args.slice(0, -1) : args;
}

/** A dynamic word may expand to an option unless literal text that no option starts with comes first: `PATH=$HOME`. */
export function mayBeOption(word: WordToken): boolean {
  return /^[-+]/.test(word.value) || word.refs.some((r) => r.start === 0) || (word.cuts ?? []).some((c) => c.at === 0);
}

/** Whether `functions -c OLD NEW` may copy a function under a new command name. */
function functionsCopies(args: WordToken[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (!word) break;
    if (word.dynamic) return mayBeOption(word);
    if (word.value === "--" || !/^[-+]./s.test(word.value)) return false;
    const cluster = splitCluster(`-${word.value.slice(1)}`, { values: ["-x"], digits: true });
    if (!cluster || cluster.flags.includes("c")) return true;
    if (cluster.end?.text === "") i++;
  }
  return false;
}

