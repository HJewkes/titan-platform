import type { WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";
import { ReadingLimitError } from "./unsure-readings.js";
import { BRACE_RE, mayBraceExpand, mayGenerate } from "./word-generation.js";

/** zsh's alias tables as parameters, and bash's: a store into any of them defines an alias without the `alias` builtin. */
const ALIAS_PARAMS = new Set(["aliases", "galiases", "saliases", "dis_aliases", "dis_galiases", "dis_saliases", "BASH_ALIASES"]);
const PARAM = String.raw`(?:(?:dis_)?[gs]?aliases|BASH_ALIASES)`;
/** A word naming an alias parameter as a store's target, alone or attached to an option cluster: `aliases[y]`, `-valiases[y]`. */
const STORED_PARAM_RE = new RegExp(String.raw`^(?:[-+][A-Za-z]*)?${PARAM}(?:\[|\+?=|$)`);
/** An alias parameter inside a `${ }` expansion, which the lexer leaves without refs. */
const EXPANDED_PARAM_RE = new RegExp(String.raw`\$\{[^}]*?(?<![A-Za-z0-9_])${PARAM}(?![A-Za-z0-9_])`);
/** An assigning expansion of a name read through `(P)`, which may name an alias parameter: `${(P)n::=git}`. */
const INDIRECT_STORE_RE = /\$\{\([^)]*P[^)]*\)[^}]*?:{0,2}=/;
/** A nameref's value naming an alias parameter: `r=BASH_ALIASES`, `r=aliases[y]`. */
const BOUND_PARAM_RE = new RegExp(String.raw`^${PARAM}(?:\[|$)`);
/** A zparseopts spec storing into an alias parameter: `h=aliases`, `v+=galiases`. */
const SPEC_PARAM_RE = new RegExp(String.raw`=${PARAM}$`);
/** A quoted expansion that may still yield several words: any `@` (`"${@:2}"`, `"${a[@]}"`), zsh flags or `=` splitting. */
const SEVERAL_RE = /@|\$\{[~^]*[=(]/;
/**
 * A glob in a command word, which may match several file names: a bracket only with its closing one, so `[` and `[[`
 * stay themselves, and a tilde only past the first character, where it is extendedglob's exclusion.
 */
const SEVERAL_NAMES_RE = /[*?#^]|\[[^\]]*\]|.~/s;
/** An alias parameter anywhere in a word, as one alternative of a brace expansion may name it. */
const BRACED_PARAM_RE = new RegExp(String.raw`(?<![A-Za-z0-9_])${PARAM}(?![A-Za-z0-9_])`);
/**
 * A declared name, with or without one subscript or an append, as it reads when nothing in it expands. Both shells
 * spare only this form of `NAME=VALUE` from globbing: `alias[e]s[[]y[]]=echo` is a pattern to zsh.
 */
const DECLARED_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^[\]]*\])?\+?$/s;

/**
 * Where a store builtin takes the name it stores into, so only a dynamic word there may name an alias parameter.
 * `names`: option letters whose value is the name; `values`: option letters whose value is anything else.
 * `operands`: which operands are names; `declare`, the part before `=`; `spec`, zparseopts specs; `store`, any once
 * an option in `stores` is given. `anywhere`: options may follow operands and `--` ends nothing, so every word is read.
 */
interface StoreSpec {
  names?: string;
  values?: string;
  operands?: "all" | "last" | "declare" | "spec" | "store" | number;
  stores?: string;
  /** Option letters under which a dynamic operand only names, never assigns: `typeset -f "$fn"`, `declare -p "$n"`. */
  inert?: string;
  anywhere?: true;
}

const DECLARE: StoreSpec = { operands: "declare", inert: "fp" };
const STORE_BUILTINS = new Map<string, StoreSpec>([
  ["typeset", DECLARE], ["declare", DECLARE], ["local", DECLARE], ["export", DECLARE], ["readonly", DECLARE],
  ["integer", DECLARE], ["float", DECLARE],
  ["set", { names: "A", values: "o" }],
  // Only -d takes a separate word in both shells; zsh reads -t/-u/-k values attached and -p/-n as flags, so a word
  // bash would take as their value is a name to zsh.
  ["read", { names: "Aa", values: "d", operands: "all" }],
  ["getln", { operands: "all" }],
  ["sysread", { names: "c", values: "iost", operands: "all" }],
  ["vared", { values: "prMmif", operands: "last" }],
  ["print", { names: "v", values: "fuCxX" }],
  ["printf", { names: "v" }],
  ["zparseopts", { names: "Aa", operands: "spec" }],
  ["getopts", { operands: 1 }],
  ["zstyle", { operands: "store", stores: "sabg" }],
  ["zformat", { names: "fa" }],
  ["strftime", { names: "s" }],
  // zsh/stat names its builtin both `zstat` and `stat`; `-H` fills a hash with a file's fields, `link` among them.
  ["zstat", { names: "AH", values: "fF" }],
  ["stat", { names: "AH", values: "fF" }],
  // -r, -w and -e are mode flags for the fds that follow them.
  ["zselect", { names: "aA", values: "t", anywhere: true }],
  ["pcre_match", { names: "vaA", values: "n" }],
  ["syswrite", { names: "c", values: "o" }],
  ["sysopen", { names: "u", values: "mo" }],
  ["syserror", { names: "e", values: "p" }],
  // Read through SUBCOMMAND_STORES; listed so a static alias parameter in any word refuses.
  ["zsystem", {}],
  ["zcurses", {}],
  ["zgetattr", { operands: 2 }],
  ["zlistattr", { operands: 1 }],
  ["zpty", { operands: "store", stores: "r" }],
  ["zregexparse", { operands: "all" }],
  ["unset", {}],
]);
/** Declarations whose `-n` makes each name a reference to the parameter its value names. */
const NAMEREF_DECLARERS = new Set(["typeset", "declare", "local"]);
/** `zsystem flock`'s options, read after the subcommand: `-f` names the parameter that gets the lock's fd. */
const FLOCK: StoreSpec = { names: "f", values: "ti" };
/** zcurses subcommands that store into the parameters after their window; the rest only draw or configure. */
const ZCURSES_STORES = new Set(["input", "querychar", "position"]);
const ZCURSES_OTHERS = new Set([
  "init", "end", "addwin", "delwin", "refresh", "touch", "move", "clear", "char", "string", "border", "attr", "bg",
  "scroll", "timeout", "mouse", "resize",
]);
/** Builtins led by a subcommand, whose store options or operands follow it. */
const SUBCOMMAND_STORES = new Map<string, (args: WordToken[]) => boolean>([
  ["zsystem", zsystemStores],
  ["zcurses", zcursesStores],
]);
/** Options `alias` itself takes, so a dynamic command word that may be `alias` is read past them. */
const ALIAS_OPTION_RE = /^[-+][gsrLm]+$/;
const DEFINITION_RE = /^[^=/\s]+=/;

/**
 * A line that defines a shell alias; the hook denies it unchecked. Eval text, `$( )` and sourced files that zsh parses
 * later in the same process expand the alias, and the guard does not model the alias table.
 */
export class AliasDefinitionError extends ReadingLimitError {
  constructor() {
    super();
    this.message = "a command that defines a shell alias";
    this.name = "AliasDefinitionError";
  }
}

/** Whether the command defines or may define an alias that text the shell parses later in the same process would expand. */
export function definesAlias(cmd: Unwrapped): boolean {
  return (
    (cmd.name === "alias" && readOptions(cmd.args).operands.some((w) => varies(w) || w.value.includes("=")))
    || (cmd.name === "enable" && enablesAliases(cmd.args))
    || cmd.assigned.some(([name]) => ALIAS_PARAMS.has(name))
    || cmd.args.some(expandsAliasParam)
    || (cmd.name !== null && storesAliasParam(cmd.name, cmd.args))
    || (cmd.name === null && dynamicDefinition(cmd.args.slice(1)))
    || (cmd.path !== null && expandedDefinition(cmd.path, cmd.args))
  );
}

/**
 * A static command word the shell still expands, which the unwrapper takes as written. Braces or a glob may turn the
 * word itself into `alias` and its operands (`{alias,y=echo}`, `ali*`), so it fails closed; a leading `~` or `=`
 * yields one word, which may be `alias`, so it reads as a dynamic one.
 */
function expandedDefinition(path: string, args: WordToken[]): boolean {
  if (BRACE_RE.test(path) || SEVERAL_NAMES_RE.test(path)) return true;
  return /^[=~]/.test(path) && dynamicDefinition(args);
}

/**
 * A store builtin whose target is an alias parameter, or may be one: a varying word where it reads the name; any option
 * word, or the first operand before `--`, that may yield several words, or a varying first operand a later word follows,
 * since either may supply a name-taking option with its name (`printf "$@"`, `print -r${=X}`, `printf "$o" x`); or a
 * nameref bound to one.
 */
function storesAliasParam(name: string, args: WordToken[]): boolean {
  const spec = STORE_BUILTINS.get(name);
  if (!spec) return false;
  if (args.some((w) => STORED_PARAM_RE.test(w.value) || (mayBraceExpand(w) && BRACED_PARAM_RE.test(w.value)))) return true;
  const bySubcommand = SUBCOMMAND_STORES.get(name);
  if (bySubcommand) return bySubcommand(args);
  if (spec.anywhere) return interleavedStores(args, spec);
  return readsStore(name, args, spec);
}

/** A varying subcommand may be `flock`, whose `-f` follows it. */
function zsystemStores(args: WordToken[]): boolean {
  const [sub, ...rest] = args;
  if (sub === undefined) return false;
  return varies(sub) || (sub.value === "flock" && readsStore("zsystem", rest, FLOCK));
}

/** A varying or unknown subcommand may be one that stores, so only a known drawing one is read as storing nothing. */
function zcursesStores(args: WordToken[]): boolean {
  const [sub, ...rest] = args;
  if (sub === undefined) return false;
  if (varies(sub) || !(ZCURSES_STORES.has(sub.value) || ZCURSES_OTHERS.has(sub.value))) return true;
  return ZCURSES_STORES.has(sub.value) && readsStore("zcurses", rest, { operands: "all" });
}

/**
 * The store reading of a builtin's options and operands under its spec: a varying or splitting target, a varying
 * operand where the spec reads a name, an option place that may supply a name-taking option, or a nameref bound to an
 * alias parameter.
 */
function readsStore(name: string, args: WordToken[], spec: StoreSpec): boolean {
  const { options, targets, operands, mayBeOption, ended } = readOptions(args, spec);
  if (targets.some((w) => varies(w) || yieldsSeveral(w)) || dynamicTargetOperand(spec, options, operands)) return true;
  const optionPlace = ended ? options : [...options, ...operands.slice(0, 1)];
  const supplies = optionPlace.some(yieldsSeveral) || (mayBeOption && operands.length > 1);
  if (supplies && (spec.names ?? spec.stores) !== undefined) return true;
  return NAMEREF_DECLARERS.has(name) && options.some((w) => /^-.*n/s.test(w.value)) && operands.some(bindsAliasParam);
}

/**
 * A word whose text is only known at run time: `$=o` included, which the lexer marks static but which splits, and a
 * word filename generation may turn into any file names.
 */
function varies(w: WordToken): boolean {
  return w.dynamic || w.unquotedExpansion === true || mayGenerate(w);
}

/** A word that may yield several words: any unquoted expansion, a quoted one that splits, a glob or a brace expansion. */
function yieldsSeveral(w: WordToken): boolean {
  return w.unquotedExpansion === true || (w.dynamic && SEVERAL_RE.test(w.value)) || mayGenerate(w);
}

/** A builtin's words as the shell reads them once expanded. */
interface OptionWords {
  options: WordToken[];
  /** The values `names` options take. */
  targets: WordToken[];
  operands: WordToken[];
  /** The first operand varies, so it may still expand to any option, a name-taking one with its name attached included. */
  mayBeOption: boolean;
  /** `--` or a lone `-` ended the options, so no operand can supply one. */
  ended: boolean;
}

/**
 * Options up to `--`, a lone `-` (both dropped) or the first operand, which every word after is too. A word led by `-`
 * and a letter is an option even when part of it expands, so `-v$n` names its target; a long option's letters are not
 * read as short ones.
 */
function readOptions(args: WordToken[], spec: StoreSpec = {}): OptionWords {
  const options: WordToken[] = [];
  const targets: WordToken[] = [];
  let i = 0;
  for (let w = args[0]; w && isOptionWord(w); w = args[++i]) {
    options.push(w);
    if (w.value.startsWith("--")) continue;
    const taken = valueLetter(w, spec);
    if (!taken) continue;
    const value = taken.attached ? w : args[++i];
    if (value && spec.names?.includes(taken.letter)) targets.push(value);
  }
  const first = args[i];
  const ends = first !== undefined && !varies(first) && (first.value === "--" || first.value === "-");
  return { options, targets, operands: args.slice(ends ? i + 1 : i), mayBeOption: first !== undefined && varies(first), ended: ends };
}

/** The first letter of an option word that takes a value, and whether that value is attached to the word. */
function valueLetter(w: WordToken, spec: StoreSpec): { letter: string; attached: boolean } | null {
  const at = [...w.value.slice(1)].findIndex((c) => `${spec.names ?? ""}${spec.values ?? ""}`.includes(c));
  if (at === -1) return null;
  return { letter: w.value.charAt(at + 1), attached: w.value.length > at + 2 };
}

/**
 * Options read wherever they stand: a varying word not led by a static digit, or one that may split, may be an option
 * with its name attached, and a varying word where a name is read may be an alias parameter.
 */
function interleavedStores(args: WordToken[], spec: StoreSpec): boolean {
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (yieldsSeveral(w) || (varies(w) && !/^\d/.test(w.value))) return true;
    if (varies(w) || !w.value.startsWith("-")) continue;
    const taken = valueLetter(w, spec);
    if (!taken) continue;
    const value = taken.attached ? w : args[++i];
    if (value && spec.names?.includes(taken.letter) && varies(value)) return true;
  }
  return false;
}

/** A word led by `-` or `+`, other than `--`; one that varies only when a letter follows its dashes statically. */
function isOptionWord(w: WordToken): boolean {
  if (w.value === "--" || !/^[-+]./s.test(w.value)) return false;
  return !varies(w) || /^(?:--?|\+)[A-Za-z]/.test(w.value);
}

function dynamicTargetOperand(spec: StoreSpec, options: WordToken[], operands: WordToken[]): boolean {
  switch (spec.operands) {
    case "all": return operands.some(varies);
    case "last": return operands.slice(-1).some(varies);
    case "declare": return !hasLetter(options, spec.inert) && operands.some((w) => varies(w) && !declaresPlainName(w));
    case "spec": return operands.some((w) => varies(w) || SPEC_PARAM_RE.test(w.value));
    case "store": return hasLetter(options, spec.stores) && operands.some(varies);
    case undefined: return false;
    default: return operands.slice(0, spec.operands + 1).some((w, k) => (k === spec.operands ? varies(w) : yieldsSeveral(w)));
  }
}

/** A declaration operand whose name nothing can change: a plain name, and an assignment if the shell may glob the word. */
function declaresPlainName(w: WordToken): boolean {
  const eq = w.value.indexOf("=");
  if (eq === -1 && mayGenerate(w)) return false;
  return DECLARED_NAME_RE.test(eq === -1 ? w.value : w.value.slice(0, eq));
}

/** Whether any option word holds one of the letters. */
function hasLetter(options: WordToken[], letters = ""): boolean {
  return options.some((w) => [...letters].some((c) => w.value.slice(1).includes(c)));
}

/** A `-n` name with no value may be bound by a later assignment, so only a static value naming no alias parameter is safe. */
function bindsAliasParam(w: WordToken): boolean {
  const eq = w.value.indexOf("=");
  return eq === -1 || w.dynamic || BOUND_PARAM_RE.test(w.value.slice(eq + 1));
}

/** `enable -a` turns disabled aliases back on; a dynamic word where options may still stand may be `-a`. */
function enablesAliases(args: WordToken[]): boolean {
  const { options, mayBeOption } = readOptions(args);
  return mayBeOption || options.some((w) => w.value.startsWith("-") && w.value.includes("a"));
}

function expandsAliasParam(w: WordToken): boolean {
  if (w.refs.some((ref) => ALIAS_PARAMS.has(ref.name))) return true;
  return w.dynamic && (EXPANDED_PARAM_RE.test(w.value) || INDIRECT_STORE_RE.test(w.value));
}

/**
 * A dynamic command word may be `alias`, so a `NAME=VALUE` operand, or a glob that may match a file so named, may
 * define one. A static option `alias` does not take means the command is something else, as in `"$PY" -c x=1`; a
 * varying one may still be an `alias` option.
 */
function dynamicDefinition(args: WordToken[]): boolean {
  const { options, operands } = readOptions(args);
  if (!options.every((w) => varies(w) || ALIAS_OPTION_RE.test(w.value))) return false;
  return operands.some((w) => mayGenerate(w) || DEFINITION_RE.test(w.value));
}
