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
const NAMEREF_DECLARERS = new Set(["typeset", "declare", "local", "export", "readonly", "private", "integer", "float"]);
const VARIABLE_TAKERS = new Set([...NAMEREF_DECLARERS, "read", "mapfile", "readarray"]);
/** The builtins that store into a named parameter; any other command writes none, whatever its words expand to. */
const STORE_BUILTINS = new Set(
  `export declare typeset local readonly private integer float read mapfile readarray printf print set wait compgen vared
  zstyle zparseopts zformat strftime zstat zselect getln sysread zregexparse pcre_match zpty zsystem syserror sysopen
  syswrite zmodload zgetattr zlistattr ztie zcurses shift compadd getopts functions`.split(/\s+/),
);

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
  if (cmd.name !== null && STORE_BUILTINS.has(cmd.name) && storesRebinding(cmd, cmd.name)) return true;
  const texts = [...cmd.args.filter((a) => a.dynamic).map((a) => a.value), ...cmd.assigned.map(([, value]) => value ?? "")];
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

/**
 * Whether a store builtin declares a nameref to a rebinding parameter, copies a function under a new name, or stores
 * into a rebinding parameter. The builtins that take a variable as an everyday operand (`export $(cmd)`,
 * `declare "$F"`, `read "$V"`) are read by their literal words only: counting a run-time word there would refuse every
 * such line, and the guard allows them today. Every other store builtin fails closed on a word it cannot read.
 */
function storesRebinding(cmd: Unwrapped, name: string): boolean {
  const literal = VARIABLE_TAKERS.has(name);
  const args = literal ? cmd.args.filter(isPlain) : cmd.args;
  if (name === "functions" && functionsCopies(args)) return true;
  const words = literal ? variableWords(name, args) : readableArgs(name, args);
  return writesProtectedParam({ ...cmd, args: words }, words, [], REBINDING_SET) !== null;
}

/** A word the shell reads as written: a run-time expansion, or an unquoted glob or brace, may become other words. */
function isPlain(word: WordToken): boolean {
  return !word.dynamic && (word.quoted || !/[{}*?]/.test(word.value));
}

/** A declarer's operands and its `-n` words, which make each operand a reference; a reader's non-option words. */
function variableWords(name: string, args: WordToken[]): WordToken[] {
  const nameref = NAMEREF_DECLARERS.has(name);
  return args.filter((a) => !/^[-+]/.test(a.value) || (nameref && /^-[A-Za-z0-9]*n/.test(a.value)) || (!nameref && /^-[A-Za-z0-9]*[aA]/.test(a.value)));
}

/**
 * The words the store reader gets: zsh skips one leading `--` before these builtins' options, and a lone quoted word
 * that is all `printf` has (a format, which needs a word after it to be `-vNAME`) stores nowhere.
 */
function readableArgs(name: string, args: WordToken[]): WordToken[] {
  if (SKIPS_LEADING_DASHES.has(name) && args[0]?.value === "--") return args.slice(1);
  const last = args.at(-1);
  const quotedLast = last?.dynamic === true && last.unquotedExpansion !== true;
  return quotedLast && name === "printf" && args.length === 1 ? args.slice(0, -1) : args;
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

