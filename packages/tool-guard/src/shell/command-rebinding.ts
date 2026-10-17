import { evaluatesArgsAsMath } from "./arith-hooked.js";
import { embeddedMathStores, fdVariableStores, operandsStore, scopeNames, storeReader } from "./arith-stores.js";
import { splitCluster } from "./cluster.js";
import { HOOKED_WRITERS, writesProtectedParam } from "./hooked-params.js";
import { nameSlots } from "./name-slots.js";
import type { RedirectToken, Token, WordToken } from "./lexer.js";
import { REBINDING, REBINDING_SET } from "./rebinding-names.js";
import { expandWord, lookup } from "./vars.js";
import type { Vars } from "./vars.js";
import { compoundBody } from "./writers.js";
import { expandsInStoreOptions, STORE_OPTION_BUILTINS } from "./store-option-zone.js";
import { ReadingLimitError } from "./unsure-readings.js";
import type { Unwrapped } from "./unwrap.js";
import { WRITER_SPECS } from "./writer-specs.js";

const REBINDING_STORE = storeReader(REBINDING_SET);

/** An expansion that assigns: `${commands[y]::=/x}`, `${functions[y]:=x}`, bash `${BASH_CMDS[y]=/x}`; a read has no `=`. */
const ASSIGNING_EXPANSION_RE = new RegExp(`\\$\\{[^}]*?\\b(?:${REBINDING.join("|")})(?:\\[[^\\]]*\\])?:{0,2}=`);
/** An expansion that assigns whatever parameter another one names: bash `${!n=/x}`, zsh `${(P)n::=/x}`. */
const INDIRECT_ASSIGNING_RE = /\$\{(?:!|\([^)]*P[^)]*\))[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?:{0,2}=/;
/** A word that opens with a rebinding parameter's name, subscript or assignment: a store even when part of it expands. */
const NAMES_REBINDING_RE = new RegExp(`^(?:${REBINDING.join("|")})(?:\\[|\\+?=|$)`);
/** Declarers print instead of storing under `-p` and `-f`: `declare -p BASH_CMDS`. */
const VARIABLE_TAKERS = new Set(["export", "declare", "typeset", "local", "readonly", "private", "integer", "float", "read", "mapfile", "readarray"]);
const PRINTS_VARIABLES = new Set(["export", "declare", "typeset", "local", "readonly", "private", "integer", "float"]);
/** Builtins whose stored-into name comes from an option value or a fixed word, so a computed operand names nothing. */
const NAME_BY_OPTION = new Set([...Object.keys(WRITER_SPECS).filter((name) => WRITER_SPECS[name]?.operands !== "names"), "getopts"]);
/** zsh `shift NAME` only drops elements from the array it names, and dropping a binding falls back to PATH. */
const DROPS_ONLY = new Set(["shift"]);
/** The words that store into a named parameter; any other command writes none, whatever its words expand to. */
const STORE_BUILTINS = new Set([...HOOKED_WRITERS, "functions"]);

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
export function rebindsCommand(cmd: Unwrapped, vars: Vars = new Map()): boolean {
  if (cmd.name === "hash" && hashBinds(cmd.args)) return true;
  if (cmd.assigned.some(([name]) => REBINDING_SET.has(name))) return true;
  if (cmd.name !== null && evaluatesArgsAsMath(cmd.name) && operandsStore(cmd.args, REBINDING_STORE, scopeNames(vars))) return true;
  if (cmd.name !== null && expandsInStoreOptions(cmd.name, cmd.args)) return true;
  if (cmd.name !== null && STORE_BUILTINS.has(cmd.name) && storesRebinding(cmd, cmd.name)) return true;
  const texts = [...cmd.args.filter((a) => a.dynamic).map((a) => a.value), ...cmd.assigned.map(([, value]) => value ?? "")];
  return texts.some((text) => ASSIGNING_EXPANSION_RE.test(text) || INDIRECT_ASSIGNING_RE.test(text));
}

/**
 * Whether a command's words store into a rebinding parameter through math, which the shell evaluates apart from any
 * builtin that names the parameter: a `$(( ))` or subscript in a run-time word, and a descriptor variable
 * (`{BASH_CMDS[y]}>f`). A run-time word in those places may expand to `commands[y]=0`.
 */
export function storesRebindingByMath(words: WordToken[], redirects: RedirectToken[], vars: Vars): boolean {
  const resolve = scopeNames(vars);
  return embeddedMathStores(words, REBINDING_STORE, resolve) || fdVariableStores(redirects, REBINDING_SET, REBINDING_STORE, resolve);
}

/**
 * Whether the `(( ))` an operator opens stores into a rebinding parameter. It reads the body's tokens whole, since a
 * `<` or `>` in it is lexed as a redirect (`(( i < $e ))` keeps `$e` as a redirect target), and runs before the
 * `(( ))`'s own writes land, which would hide a store a name held (`X='commands[y]=0'; (( X++ ))`).
 */
export function compoundStoresRebinding(op: Token, vars: Vars): boolean {
  const expand = (w: WordToken) => expandWord(w, (name) => lookup(vars, null, name));
  const words = (compoundBody(op) ?? []).flatMap((t) => (t.type === "word" ? [expand(t)] : t.type === "redirect" && t.target ? [expand(t.target)] : []));
  return operandsStore(words, REBINDING_STORE, scopeNames(vars));
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
 * into a rebinding parameter. A word that expands at run time in a name slot may be any name, so it counts, after
 * `--` too: `read -- "$n"`, `declare "$x"`, `zstyle -s :a k "$n"`. One where options are still read is
 * `expandsInStoreOptions`'s.
 */
function storesRebinding(cmd: Unwrapped, name: string): boolean {
  if (name === "functions" && functionsCopies(cmd.args)) return true;
  const own = cmd.args;
  if (PRINTS_VARIABLES.has(name)) {
    const operands = declarerOperands(own);
    if (operands.some((a) => NAMES_REBINDING_RE.test(a.value) && a.value.includes("="))) return true;
    if (printsOnly(own, operands)) return false;
  }
  const args = variableWords(name, own.filter((a) => NAMES_REBINDING_RE.test(a.value) || (!a.dynamic && !isGlob(a, name))));
  if (writesProtectedParam({ ...cmd, args }, args, [], REBINDING_SET) !== null) return true;
  return dynamicSlot(name, printsFunction(name, own) ? own.slice(0, -1) : own);
}

/**
 * Whether the stored-into name is computed at run time (`wait -p "$n" $!`, `read -- "$n"`, `declare "$x"=v`), or
 * sits in an option word the reader cannot split. A run-time word where a declarer or reader may read an option or a
 * name may be either, so it counts: `declare "$x"`.
 */
function dynamicSlot(name: string, args: WordToken[]): boolean {
  if (DROPS_ONLY.has(name)) return false;
  if (namedByDynamicWord(name, args)) return true;
  const byOption = NAME_BY_OPTION.has(name);
  const slots = nameSlots(name, args);
  if (typeof slots !== "string") return slots.some((slot) => (byOption ? slot.dynamic : dynamicName(slot)));
  if (/^[-+]/.test(slots) && /[$`]/.test(slots)) return true;
  return !byOption && args.some((a) => a.dynamic && a.value === slots);
}

/** Whether an operand's name, the text before any `=`, expands: `"$x"`, `"$V=d"`, `${n}=x`, but not `PATH="$HOME"`. */
function dynamicName(slot: WordToken): boolean {
  const eq = slot.value.indexOf("=");
  const end = eq < 0 ? slot.value.length : eq;
  return slot.dynamic && (/[$`]/.test(slot.value.slice(0, end)) || (slot.cuts ?? []).some((cut) => cut.at <= end));
}

/** A literal option word ending in a store letter, followed by the run-time word that is its name. */
function namedByDynamicWord(name: string, args: WordToken[]): boolean {
  const stores = STORE_OPTION_BUILTINS.get(name)?.stores ?? "";
  return args.some((word, i) => {
    const storeLast = !word.dynamic && /^[-+][A-Za-z0-9]+$/.test(word.value) && stores.includes(word.value.slice(-1));
    return storeLast && args[i + 1]?.dynamic === true;
  });
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

/** A lone quoted run-time word after a literal `-f` names a function to print, not a name to store: `declare -f "$fn"`. */
function printsFunction(name: string, args: WordToken[]): boolean {
  const last = args.at(-1);
  if (!PRINTS_VARIABLES.has(name) || last?.dynamic !== true || last.unquotedExpansion === true) return false;
  return args.slice(0, -1).some((a) => !a.dynamic && /^-[A-Za-z0-9]*f/.test(a.value));
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

