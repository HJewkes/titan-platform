import { splitCluster } from "./cluster.js";
import type { WordToken } from "./lexer.js";
import { ReadingLimitError } from "./unsure-readings.js";
import type { Unwrapped } from "./unwrap.js";

/** Parameters whose stores bind a command name, or a `~name`, to something the guard never reads as that name. */
const REBINDING = ["commands", "BASH_CMDS", "functions", "dis_functions", "nameddirs"];
const REBINDING_SET = new Set(REBINDING);
/** The name a store operand writes: `commands`, `commands[y]=…`, `functions+=…`, zsh read's `commands?prompt`. */
const TARGET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(?=\[|\+?=|\?|$)/s;
/** An expansion that assigns: `${commands[y]::=/x}`, `${functions[y]:=x}`, bash `${BASH_CMDS[y]=/x}`; a read has no `=`. */
const ASSIGNING_EXPANSION_RE = new RegExp(`\\$\\{[^}]*?\\b(?:${REBINDING.join("|")})(?:\\[[^\\]]*\\])?:{0,2}=`);
/** An expansion that assigns whatever parameter another one names: bash `${!n=/x}`, zsh `${(P)n::=/x}`. */
const INDIRECT_ASSIGNING_RE = /\$\{(?:!|\([^)]*P[^)]*\))[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?:{0,2}=/;
const NAMEREF_DECLARERS = new Set(["typeset", "declare", "local"]);

/**
 * How a builtin that stores into a named parameter reads its words: option letters taking a value, option letters whose
 * value is the name it stores into, and which operands are such names. `loose` marks value letters one shell reads as a
 * flag, as zsh does `read -p`, `-n` and `-t`, so each value word may be a name the builtin stores into.
 */
interface StoreSpec {
  values: string;
  targets: string;
  operands: "all" | "none" | number;
  loose?: true;
}

const DECLARER: StoreSpec = { values: "", targets: "", operands: "all" };
const STORERS: Record<string, StoreSpec> = {
  typeset: DECLARER, declare: DECLARER, local: DECLARER, export: DECLARER, readonly: DECLARER, integer: DECLARER, float: DECLARER,
  vared: { values: "prifMm", targets: "", operands: "all" },
  read: { values: "dinNptu", targets: "a", operands: "all", loose: true },
  getln: { values: "", targets: "", operands: "all" },
  zformat: { values: "", targets: "", operands: 0 },
  mapfile: { values: "dnOsuCc", targets: "", operands: "all" },
  readarray: { values: "dnOsuCc", targets: "", operands: "all" },
  set: { values: "o", targets: "A", operands: "none" },
  getopts: { values: "", targets: "", operands: 1 },
  printf: { values: "", targets: "v", operands: "none" },
  print: { values: "fCuxX", targets: "v", operands: "none" },
};
/** zsh `zparseopts -a ARRAY -A ASSOC SPEC...`, the name attached or next; each `SPEC=ARRAY` stores too. */
const ZPARSEOPTS: StoreSpec = { values: "", targets: "aA", operands: "none" };
/** zsh `functions`, where `-x` takes an indent and `-c OLD NEW` copies a function under a new command name. */
const FUNCTIONS: StoreSpec = { values: "x", targets: "", operands: "none" };
/** zsh builtins that skip one leading `--` and still read options after it: `zparseopts -- -A commands y:`. */
const SKIPS_LEADING_DASHES = new Set(["zparseopts", "zstyle", "zformat"]);

type Target = [word: WordToken, from: number];

/** What a store builtin's options say: their letters with the sign they came under, the names they store into, and where operands start. */
interface Options {
  flags: string[];
  targets: Target[];
  end: number;
  /** A dynamic word where an option may stand, which may expand to any option, or an option word no cluster reads. */
  unsureAt: number | null;
}

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
  if (cmd.name !== null && storesRebinding(cmd.name, cmd.args)) return true;
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

/** Whether a store builtin declares a nameref or writes a rebinding parameter, or one only known at run time. */
function storesRebinding(name: string, words: WordToken[]): boolean {
  const args = SKIPS_LEADING_DASHES.has(name) && words[0]?.value === "--" ? words.slice(1) : words;
  if (name === "zparseopts") return zparseoptsStores(args);
  if (name === "functions") return functionsCopies(args);
  if (name === "zstyle") return zstyleStores(args);
  const spec = STORERS[name];
  if (!spec) return false;
  const options = readOptions(args, spec);
  if (options.unsureAt !== null && unsureOptionCounts(name, args, options.unsureAt, options.flags)) return true;
  if (NAMEREF_DECLARERS.has(name) && options.flags.includes("-n")) return true;
  const targets = [...options.targets, ...operandTargets(spec, args.slice(options.end), options.flags)];
  return targets.some(([word, from]) => targetRebinds(word, from));
}

/** Walks each option cluster the way getopt does, so an attached value (`-pinput`, `-Acommands`) ends it. */
function readOptions(args: WordToken[], spec: StoreSpec): Options {
  const flags: string[] = [];
  const targets: Target[] = [];
  const values = [...spec.values, ...spec.targets].map((c) => `-${c}`);
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (!word) break;
    if (word.dynamic) return { flags, targets, end: i, unsureAt: mayBeOption(word) ? i : null };
    if (word.value === "--") return { flags, targets, end: i + 1, unsureAt: null };
    if (!/^[-+]./s.test(word.value)) return { flags, targets, end: i, unsureAt: null };
    const cluster = splitCluster(`-${word.value.slice(1)}`, { values, digits: true });
    if (!cluster) return { flags, targets, end: i, unsureAt: i };
    flags.push(...cluster.flags.map((f) => (word.value[0] ?? "") + f));
    if (!cluster.end) continue;
    const attached = cluster.end.text !== "";
    const value = attached ? word : args[++i];
    const named = spec.targets.includes(cluster.end.option) || (spec.loose === true && !attached);
    if (value && named) targets.push([value, attached ? word.value.length - cluster.end.text.length : 0]);
  }
  return { flags, targets, end: args.length, unsureAt: null };
}

/** A dynamic word may expand to an option unless literal text that no option starts with comes first: `PATH=$HOME`. */
function mayBeOption(word: WordToken): boolean {
  return /^[-+]/.test(word.value) || word.refs.some((r) => r.start === 0) || (word.cuts ?? []).some((c) => c.at === 0);
}

/** Whether `zparseopts` stores into a rebinding parameter through `-a`/`-A` or a spec's `=ARRAY`, or may. */
function zparseoptsStores(args: WordToken[]): boolean {
  const options = readOptions(args, ZPARSEOPTS);
  if (options.unsureAt !== null) return true;
  const specs = args.slice(options.end).map((w): Target | null => {
    const at = w.value.lastIndexOf("=");
    return at < 0 ? (w.dynamic ? [w, 0] : null) : [w, at + 1];
  });
  return [...options.targets, ...specs.filter((t) => t !== null)].some(([word, from]) => targetRebinds(word, from));
}

/** Whether `functions -c OLD NEW` may copy a function under a new command name. */
function functionsCopies(args: WordToken[]): boolean {
  const options = readOptions(args, FUNCTIONS);
  return options.unsureAt !== null || options.flags.includes("-c");
}

/** zsh `zstyle -s/-b/-a/-h CONTEXT STYLE NAME` and `-g NAME` store into a parameter; any operand may be that name. */
function zstyleStores(args: WordToken[]): boolean {
  const first = args[0];
  if (!first || first.dynamic) return first !== undefined;
  return /^-[abghs]/.test(first.value) && args.slice(1).some((w) => targetRebinds(w, 0));
}

/**
 * Whether an unsure option word may make the builtin store somewhere. Quoted, it is one word: last after a declarer's `-f`
 * it names a function to print, and printf's needs a word after it to be `-vNAME FORMAT`, while zsh `print -vNAME` stores
 * even with nothing after it. Unquoted, it may split into any.
 */
function unsureOptionCounts(name: string, args: WordToken[], at: number, flags: string[]): boolean {
  if (args[at]?.unquotedExpansion === true) return true;
  if (STORERS[name] === DECLARER && flags.includes("-f") && at === args.length - 1) return false;
  return name !== "printf" || at < args.length - 1;
}

/** The operands that name a parameter the builtin stores into; a declarer's `-f` only prints functions. */
function operandTargets(spec: StoreSpec, operands: WordToken[], flags: string[]): Target[] {
  if (spec.operands === "none" || (spec === DECLARER && flags.includes("-f"))) return [];
  const words = spec.operands === "all" ? operands : operands.slice(spec.operands, spec.operands + 1);
  return words.map((w): Target => [w, 0]);
}

/** Whether the name at `from` is a rebinding parameter, or is spliced from an expansion so it may be one. */
function targetRebinds(word: WordToken, from: number): boolean {
  const text = word.value.slice(from);
  const name = TARGET_NAME_RE.exec(text)?.[0];
  if (name === undefined) return word.dynamic;
  const end = from + name.length;
  if (word.refs.some((r) => r.start <= end) || (word.cuts ?? []).some((c) => c.at <= end)) return true;
  return REBINDING_SET.has(name);
}
