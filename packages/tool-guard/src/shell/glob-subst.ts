import type { WordToken } from "./lexer.js";
import type { Unwrapped } from "./unwrap.js";

/**
 * Whether a command may turn on zsh's GLOB_SUBST, under which a later unquoted `$x` holding `*(e:CODE:)` runs CODE
 * as a glob qualifier. Both polarities and every spelling zsh accepts count, as does any operand only known at run
 * time, so the reading fails closed: `unsetopt noglobsubst` enables it and `setopt $o` may.
 */
export function mayEnableGlobSubst(cmd: Unwrapped): boolean {
  if (cmd.assigned.some(([name]) => name === "options") || cmd.args.some(readsOptions)) return true;
  if (cmd.name === null) return cmd.args.length > 0 && dynamicCommand(cmd.args);
  if (WRITERS.has(cmd.name) && cmd.args.some((a) => OPTIONS_OPERAND_RE.test(a.value))) return true;
  const check = Object.hasOwn(ENABLERS, cmd.name) ? ENABLERS[cmd.name] : undefined;
  return check?.(cmd.args) ?? false;
}

/** Commands that write the parameter a word names; `set -A` is read with `set`'s own options. */
const WRITERS = new Set(["local", "export", "declare", "typeset", "readonly", "integer", "float", "read", "vared", "getopts", "zparseopts"]);
/** `options`, `options[k]=v` or `options+=v`, alone or attached to a short option as in `zparseopts -Aoptions`. */
const OPTIONS_OPERAND_RE = /^(?:-[A-Za-z]*)?options(?:\[|\+?=|$)/;
/** `${options[globsubst]::=on}` assigns through an expansion; `refs` hold only plain names, so the text is read too. */
const OPTIONS_EXPANSION_RE = /\$\{[^}]*\boptions\b/;

const ENABLERS: Record<string, (args: WordToken[]) => boolean> = {
  setopt: setoptEnables,
  unsetopt: setoptEnables,
  set: setEnables,
  emulate: emulateEnables,
  zsh: zshEnables,
};

/** zsh ignores case, `_` and `-` in an option name, and each leading `no` flips it. */
function namesGlobSubst(name: string): boolean {
  let norm = name.toLowerCase().replace(/[_-]/g, "");
  while (norm.startsWith("no")) norm = norm.slice(2);
  return norm === "globsubst";
}

function readsOptions(w: WordToken): boolean {
  return w.refs.some((ref) => ref.name === "options") || (w.dynamic && OPTIONS_EXPANSION_RE.test(w.value));
}

interface OptionScan {
  /** Option names `-o NAME`, `-oNAME`, `+o NAME` and `--NAME` bring in. */
  names: string[];
  /** Names `-A` and `+A` take. */
  arrays: string[];
  /** Every other short option letter. */
  flags: string;
  /** Non-option words, in order. */
  operands: string[];
  /** `--emulate` values. */
  modes: string[];
  dynamic: boolean;
}

/**
 * Reads option words up to `--`, or up to the first operand when `untilOperand` is set. Each letter of `valued` takes
 * the rest of its cluster or the next word as its value, which `c` drops since that is shell text the walk reads.
 */
function scanOptions(args: WordToken[], valued: string, untilOperand: boolean): OptionScan {
  const scan: OptionScan = { names: [], arrays: [], flags: "", operands: [], modes: [], dynamic: false };
  for (let i = 0; i < args.length; i++) {
    const w = args[i] as WordToken;
    if (w.dynamic) scan.dynamic = true;
    if (w.dynamic && untilOperand) break;
    if (w.value === "--" || (untilOperand && !isOptionWord(w.value))) break;
    if (w.dynamic) continue;
    if (w.value.startsWith("--")) i = readLong(args, i, scan);
    else if (isOptionWord(w.value)) i = readCluster(args, i, valued, scan);
    else scan.operands.push(w.value);
  }
  return scan;
}

function isOptionWord(value: string): boolean {
  return /^[-+]./.test(value);
}

function readLong(args: WordToken[], i: number, scan: OptionScan): number {
  const value = (args[i] as WordToken).value;
  const [option, attached] = value.split(/=(.*)/s);
  if (option !== "--emulate") {
    scan.names.push(value);
    return i;
  }
  return takeValue(args, i, attached ?? "", (mode) => scan.modes.push(mode), scan);
}

function readCluster(args: WordToken[], i: number, valued: string, scan: OptionScan): number {
  const value = (args[i] as WordToken).value;
  for (let j = 1; j < value.length; j++) {
    const letter = value[j] as string;
    if (!valued.includes(letter)) {
      scan.flags += letter;
      continue;
    }
    const into = letter === "o" ? scan.names : letter === "A" ? scan.arrays : [];
    return takeValue(args, i, value.slice(j + 1), (v) => into.push(v), scan);
  }
  return i;
}

/** The value attached to the option at `i`, or else the next word; returns the index of the last word read. */
function takeValue(args: WordToken[], i: number, attached: string, keep: (value: string) => void, scan: OptionScan): number {
  if (attached) {
    keep(attached);
    return i;
  }
  const next = args[i + 1];
  if (next?.dynamic) scan.dynamic = true;
  else if (next) keep(next.value);
  return i + 1;
}

function setoptEnables(args: WordToken[]): boolean {
  const scan = scanOptions(args, "o", false);
  return scan.dynamic || scan.flags.includes("m") || [...scan.names, ...scan.operands].some(namesGlobSubst);
}

function setEnables(args: WordToken[]): boolean {
  const scan = scanOptions(args, "oA", true);
  return scan.dynamic || scan.names.some(namesGlobSubst) || scan.arrays.includes("options");
}

/** Every mode but zsh sets GLOB_SUBST; zsh 5.9 still ran no qualifier under sh or ksh, but later options may change that. */
function emulateEnables(args: WordToken[]): boolean {
  const scan = scanOptions(args, "oc", false);
  return scan.dynamic || scan.names.some(namesGlobSubst) || scan.operands.some((mode) => mode !== "zsh");
}

/** Only zsh evaluates glob qualifiers, so `bash -o globsubst` is left alone. */
function zshEnables(args: WordToken[]): boolean {
  const scan = scanOptions(args, "o", true);
  return scan.dynamic || scan.names.some(namesGlobSubst) || scan.modes.some((mode) => mode !== "zsh");
}

/** A command word only known at run time may be `setopt` or an assignment builtin. */
function dynamicCommand(args: WordToken[]): boolean {
  const [, ...rest] = args;
  const scan = scanOptions(rest, "o", false);
  return [...scan.names, ...scan.operands].some(namesGlobSubst) || rest.some((a) => OPTIONS_OPERAND_RE.test(a.value));
}
