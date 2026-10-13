import type { WordToken } from "./lexer.js";
import { ReadingLimitError } from "./unsure-readings.js";
import type { Unwrapped } from "./unwrap.js";

/** Parameters whose stores bind a command name, or a `~name`, to something the guard never reads as that name. */
const REBINDING = ["commands", "BASH_CMDS", "functions", "dis_functions", "nameddirs"];
const REBINDING_SET = new Set(REBINDING);
/** The name a store operand writes: `commands`, `commands[y]=…`, `functions+=…`. */
const TARGET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(?=\[|\+?=|$)/s;
/** An expansion that assigns: `${commands[y]::=/x}`, `${functions[y]:=x}`, bash `${BASH_CMDS[y]=/x}`; a read has no `=`. */
const ASSIGNING_EXPANSION_RE = new RegExp(`\\$\\{[^}]*?\\b(?:${REBINDING.join("|")})(?:\\[[^\\]]*\\])?:{0,2}=`);
/** An expansion that assigns whatever parameter another one names: bash `${!n=/x}`, zsh `${(P)n::=/x}`. */
const INDIRECT_ASSIGNING_RE = /\$\{(?:!|\([^)]*P[^)]*\))[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?:{0,2}=/;
/** A `zparseopts` word naming its store: `-A commands`'s value, or a spec's `x=commands`. */
const ZPARSEOPTS_STORE_RE = new RegExp(`(?:^|=)(?:${REBINDING.join("|")})$`);
const DECLARERS = new Set(["typeset", "declare", "local", "export", "readonly", "integer", "float", "vared"]);
/** Declarers where `-n` makes a nameref, whose later stores land in whatever parameter it names. */
const NAMEREF_DECLARERS = new Set(["typeset", "declare", "local"]);
/** Option letters whose next word is a value, not a name the builtin stores into. */
const VALUE_LETTERS: Record<string, string> = { read: "dinNptu", mapfile: "dnOsuCc", readarray: "dnOsuCc", print: "fCuxX" };

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
function storesRebinding(name: string, args: WordToken[]): boolean {
  if (NAMEREF_DECLARERS.has(name) && optionWords(args).some((w) => /^-[^-]*n/s.test(w.value))) return true;
  if (name === "zparseopts") return args.some((a) => a.dynamic || ZPARSEOPTS_STORE_RE.test(a.value));
  return storeTargets(name, args).some(([word, from]) => targetRebinds(word, from));
}

/** The words, with the offset its name starts at, that name a parameter the builtin stores into. */
function storeTargets(name: string, args: WordToken[]): Array<[WordToken, number]> {
  const operands = afterOptions(args, VALUE_LETTERS[name] ?? "");
  const whole = (words: Array<WordToken | undefined>) => words.filter((w) => w !== undefined).map((w): [WordToken, number] => [w, 0]);
  if (DECLARERS.has(name) || name === "read" || name === "mapfile" || name === "readarray") return whole(operands);
  if (name === "set") return optionWords(args).some((w) => w.value.includes("A")) ? whole([operands[0]]) : [];
  if (name === "getopts") return whole([operands[1]]);
  if (name === "printf" || name === "print") return optionValue(args, "v", VALUE_LETTERS[name] ?? "");
  return [];
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

const isOptionWord = (w: WordToken) => !w.dynamic && w.value !== "--" && /^[-+]./s.test(w.value);

/** Indexes of the option words before the first operand, past the word an option in `values` takes; then where operands start. */
function scanOptions(args: WordToken[], values: string): { options: number[]; end: number } {
  const options: number[] = [];
  let i = 0;
  while (i < args.length && isOptionWord(args[i] as WordToken)) {
    options.push(i);
    if (values.includes((args[i++] as WordToken).value.at(-1) ?? "")) i++;
  }
  return { options, end: args[i]?.value === "--" ? i + 1 : i };
}

function optionWords(args: WordToken[]): WordToken[] {
  return scanOptions(args, "").options.map((i) => args[i] as WordToken);
}

function afterOptions(args: WordToken[], values: string): WordToken[] {
  return args.slice(scanOptions(args, values).end);
}

/** The word `-v` names, attached (`-vNAME`) or next, scanning clusters until a letter in `values` takes the rest. */
function optionValue(args: WordToken[], letter: string, values: string): Array<[WordToken, number]> {
  for (const i of scanOptions(args, values).options) {
    const word = args[i] as WordToken;
    const at = [...word.value].findIndex((c, j) => j > 0 && (c === letter || values.includes(c)));
    if (at < 0 || word.value[at] !== letter) continue;
    const next = at === word.value.length - 1 ? args[i + 1] : word;
    return next ? [[next, next === word ? at + 1 : 0]] : [];
  }
  return [];
}
