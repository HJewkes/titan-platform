import { splitCluster } from "./cluster.js";
import { writesProtectedParam } from "./hooked-params.js";
import { nameSlots } from "./name-slots.js";
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
/** A word that opens with a rebinding parameter's name, subscript or assignment: a store even when part of it expands. */
const NAMES_REBINDING_RE = new RegExp(`^(?:${REBINDING.join("|")})(?:\\[|\\+?=|$)`);
/** Declarers print instead of storing under `-p` and `-f`: `declare -p BASH_CMDS`. */
const VARIABLE_TAKERS = new Set(["export", "declare", "typeset", "local", "readonly", "private", "integer", "float", "read", "mapfile", "readarray"]);
const PRINTS_VARIABLES = new Set(["export", "declare", "typeset", "local", "readonly", "private", "integer", "float"]);
/** Builtins whose stored-into name comes from an option value or a fixed word, so a computed one may be anything. */
const NAME_BY_OPTION = new Set(["printf", "print", "set", "wait", "compgen", "zparseopts", "zformat", "strftime", "zstat", "zselect", "pcre_match", "getopts"]);
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
 * into a rebinding parameter. It reads a word that expands at run time only where it is the name being stored into
 * (`printf -v "$n"`, `wait -p "$n"`, `set -A "$n"`): a value or argument word (`print $x`, `wait $!`, `shift $((n-1))`)
 * stores nowhere. `export $(cmd)`, `declare "$F"` and `read "$V"` are not read either, and the guard allows them today.
 */
function storesRebinding(cmd: Unwrapped, name: string): boolean {
  if (name === "functions" && functionsCopies(cmd.args)) return true;
  const own = skipLeadingDashes(name, cmd.args);
  if (PRINTS_VARIABLES.has(name)) {
    const operands = declarerOperands(own);
    if (operands.some((a) => NAMES_REBINDING_RE.test(a.value) && a.value.includes("="))) return true;
    if (printsOnly(own, operands)) return false;
  }
  const args = variableWords(name, own.filter((a) => NAMES_REBINDING_RE.test(a.value) || (!a.dynamic && !isGlob(a, name))));
  if (writesProtectedParam({ ...cmd, args }, args, [], REBINDING_SET) !== null) return true;
  return NAME_BY_OPTION.has(name) && dynamicSlot(name, own);
}

/**
 * A declarer's words from its first operand on. Its options run only until then, so a later `-p` is an operand the
 * shell rejects after storing the ones before it: `declare BASH_CMDS[q]=/x -p`. A number after an option word is zsh's
 * value for it: `typeset -L 5 x`.
 */
function declarerOperands(args: WordToken[]): WordToken[] {
  for (const [i, word] of args.entries()) {
    if (word.value === "--" && !word.dynamic) return args.slice(i + 1);
    const optionValue = /^\d+$/.test(word.value) && /^[-+]/.test(args[i - 1]?.value ?? "");
    if (word.dynamic || (!/^[-+]./.test(word.value) && !optionValue)) return args.slice(i);
  }
  return [];
}

/** Whether a literal leading `-p` or `-f` makes the declarer print, not store: `declare -p BASH_CMDS`. */
function printsOnly(args: WordToken[], operands: WordToken[]): boolean {
  if (args.some((a) => a.dynamic)) return false;
  return args.slice(0, args.length - operands.length).some((a) => /^-[A-Za-z0-9]*[pf]/.test(a.value));
}

/** An unquoted glob or brace in a declarer's operand is not a name: `readonly {}` under `xargs -I{}`. */
function isGlob(word: WordToken, name: string): boolean {
  return VARIABLE_TAKERS.has(name) && !word.quoted && /[{}*?]/.test(word.value);
}

/**
 * What a declarer or a reader keeps of its options: `-n`, which makes each operand a reference, and `read`'s array
 * letters. Another letter stores nothing, and the shell rejects one it does not know.
 */
function variableWords(name: string, args: WordToken[]): WordToken[] {
  if (!VARIABLE_TAKERS.has(name)) return args;
  const keep = PRINTS_VARIABLES.has(name) ? /^-[A-Za-z0-9]*n/ : /^-[A-Za-z0-9]*[aA]/;
  return args.filter((a) => !/^[-+]/.test(a.value) || keep.test(a.value));
}

/** The option letters whose value is the name a builtin stores into. */
const NAME_LETTERS: Record<string, string> = {
  printf: "v", print: "v", wait: "p", set: "A", compgen: "V", zparseopts: "aAv", zformat: "faF", strftime: "s", zstat: "AH", zselect: "aA", pcre_match: "va",
};

/**
 * Whether the stored-into name is computed at run time, or a run-time word may be the option that names it. A word
 * that may expand to `-v` in front of a literal rebinding name (`printf "$f" BASH_CMDS[y] /x`) stores into it, so it
 * counts; so does an unquoted first operand of `printf`, which bash splits into `-v NAME VALUE`. `wait $pid` and
 * `print $x` do not split into an option the shell reads, so they pass.
 */
function dynamicSlot(name: string, args: WordToken[]): boolean {
  const slots = nameSlots(name, args);
  if (typeof slots !== "string" && slots.some((slot) => slot.dynamic)) return true;
  if (typeof slots === "string" && /^[-+]/.test(slots) && /[$`]/.test(slots)) return true;
  return namedByDynamicOption(name, args) || (name === "printf" && splitsIntoOptions(args));
}

/** A literal name option whose name is computed, or a word that may be an option ahead of a literal rebinding name. */
function namedByDynamicOption(name: string, args: WordToken[]): boolean {
  const letters = NAME_LETTERS[name] ?? "";
  for (const [i, word] of args.entries()) {
    if (!word.dynamic && /^[-+][A-Za-z0-9]+$/.test(word.value) && letters.includes(word.value.slice(-1)) && args[i + 1]?.dynamic === true) return true;
    if (word.dynamic && mayBeOption(word) && args.slice(i + 1).some((a) => NAMES_REBINDING_RE.test(a.value))) return true;
  }
  return false;
}

/** `printf $args` splits in bash, so its first operand may be `-v NAME VALUE`. */
function splitsIntoOptions(args: WordToken[]): boolean {
  const first = args.find((a) => a.dynamic || !/^-/.test(a.value));
  return first?.dynamic === true && first.unquotedExpansion === true && !first.quoted;
}

/** zsh skips one leading `--` before these builtins' options: `zparseopts -- -A commands y:`. */
function skipLeadingDashes(name: string, args: WordToken[]): WordToken[] {
  return SKIPS_LEADING_DASHES.has(name) && args[0]?.value === "--" ? args.slice(1) : args;
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

