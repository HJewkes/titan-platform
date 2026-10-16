import type { WordToken } from "./lexer.js";
import { argv0Values } from "./argv0.js";
import type { Unwrapped } from "./unwrap.js";

/**
 * Whether a command names zsh's GLOB_SUBST, under which a later unquoted `$x` holding `*(e:CODE:)` runs CODE as a glob
 * qualifier. Both polarities and every spelling zsh accepts count, as does any option-name word only known at run
 * time, so the reading fails closed: `unsetopt noglobsubst` names it and `setopt $o` may. A command word that is
 * dynamic or may expand is read as each of the commands that take option names, and refuses when any of its arguments
 * is unknowable. Stores into `options` and shell text run elsewhere are other readers' work.
 */
export function namesGlobSubstOption(cmd: Unwrapped): boolean {
  const unknownProgram = cmd.name === null || (cmd.path !== null && mayExpand(cmd.path));
  const runsZsh = unknownProgram || cmd.script !== undefined || cmd.name === "zsh" || cmd.name === "rzsh";
  if (runsZsh && cmd.argv0?.some(argv0Emulates)) return true;
  if (cmd.name === null) return dynamicCommand(cmd.args.slice(1));
  if (unknownProgram) return dynamicCommand(cmd.args);
  const check = Object.hasOwn(ENABLERS, cmd.name) ? ENABLERS[cmd.name] : undefined;
  return check?.(cmd.args) ?? false;
}

/** Characters brace expansion or filename generation reads, extendedglob's `^`, `#` and `~` included;
 * a leading `~` is tilde expansion instead, safe only bare or as `~/`, since `~name` and `~1` read a named dir or
 * the dirstack. A split quote may leave any of them unquoted. */
const PATTERN_RE = /[{*?[^#]|.~|^~(?!\/|$)/s;

const ENABLERS: Record<string, (args: WordToken[]) => boolean> = {
  setopt: setoptEnables,
  unsetopt: setoptEnables,
  set: setEnables,
  emulate: emulateEnables,
  zsh: zshEnables,
  rzsh: zshEnables,
};

/** A command word brace expansion or a glob may rewrite; the test words `[` and `[[` are none. */
function mayExpand(path: string): boolean {
  return path !== "[" && path !== "[[" && PATTERN_RE.test(path);
}

/** zsh started as `sh`, `-ksh` or `/bin/rksh` emulates that shell, read like an `emulate` mode, so GLOB_SUBST is on. */
function argv0Emulates(name: string | null): boolean {
  return name === null || EMULATION_RE.test(name.replace(/^.*\//s, "").replace(/^-/, ""));
}

/** zsh ignores case, `_` and `-` in an option name, and each leading `no` flips it. */
function namesGlobSubst(name: string): boolean {
  let norm = name.toLowerCase().replace(/[_-]/g, "");
  while (norm.startsWith("no")) norm = norm.slice(2);
  return norm === "globsubst";
}

interface OptionScan {
  /** Option names `-o NAME`, `-oNAME`, `+o NAME` and `--NAME` bring in. */
  names: string[];
  /** Every other short option letter. */
  flags: string;
  /** Non-option words, in order. */
  operands: string[];
  /** `--emulate` values. */
  modes: string[];
  /** Some word is only known at run time or may expand to others. */
  dynamic: boolean;
}

/**
 * Reads option words up to `--`, or up to the first operand when `untilOperand` is set. Each letter of `valued` takes
 * the rest of its cluster or the next word as its value, which `c` drops since that is shell text the walk reads.
 */
function scanOptions(args: WordToken[], valued: string, untilOperand: boolean): OptionScan {
  const scan: OptionScan = { names: [], flags: "", operands: [], modes: [], dynamic: false };
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === undefined) break;
    if (unknowable(w)) scan.dynamic = true;
    if (scan.dynamic && untilOperand) break;
    if (w.value === "--" && !untilOperand) readOperands(args.slice(i + 1), scan);
    if (w.value === "--" || (untilOperand && !isOptionWord(w.value))) break;
    if (unknowable(w)) continue;
    if (w.value.startsWith("--")) i = readLong(args, i, scan);
    else if (isOptionWord(w.value)) i = readCluster(args, i, valued, scan);
    else scan.operands.push(w.value);
  }
  return scan;
}

/** After `--`, `setopt` and `emulate` still read each word as an option name or a mode. */
function readOperands(words: WordToken[], scan: OptionScan): void {
  for (const w of words) {
    if (unknowable(w)) scan.dynamic = true;
    else scan.operands.push(w.value);
  }
}

/** A word only known at run time, or one brace expansion or filename generation may turn into other words. */
function unknowable(w: WordToken): boolean {
  return w.dynamic || (PATTERN_RE.test(w.value) && (!w.quoted || w.spliced));
}

function isOptionWord(value: string): boolean {
  return /^[-+]./.test(value);
}

function readLong(args: WordToken[], i: number, scan: OptionScan): number {
  const value = args[i]?.value ?? "";
  const [option, attached] = value.split(/=(.*)/s);
  if (option !== "--emulate") {
    scan.names.push(value);
    return i;
  }
  return takeValue(args, i, attached ?? "", (mode) => scan.modes.push(mode), scan);
}

function readCluster(args: WordToken[], i: number, valued: string, scan: OptionScan): number {
  const value = args[i]?.value ?? "";
  for (let j = 1; j < value.length; j++) {
    const letter = value.charAt(j);
    if (!valued.includes(letter)) {
      scan.flags += letter;
      continue;
    }
    const into = letter === "o" ? scan.names : [];
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
  if (next && unknowable(next)) scan.dynamic = true;
  else if (next) keep(next.value);
  return i + 1;
}

function setoptEnables(args: WordToken[]): boolean {
  const scan = scanOptions(args, "o", false);
  return scan.dynamic || scan.flags.includes("m") || [...scan.names, ...scan.operands].some(namesGlobSubst);
}

function setEnables(args: WordToken[]): boolean {
  const scan = scanOptions(args, "oA", true);
  return scan.dynamic || scan.names.some(namesGlobSubst);
}

/** The first operand is the mode; zsh 5.9 still ran no qualifier under sh or ksh, but later options may change that. */
function emulateEnables(args: WordToken[]): boolean {
  const scan = scanOptions(args, "oc", false);
  return scan.dynamic || scan.names.some(namesGlobSubst) || EMULATION_RE.test(scan.operands[0] ?? "");
}

/** Only zsh evaluates glob qualifiers, so `bash -o globsubst` is left alone. */
function zshEnables(args: WordToken[]): boolean {
  const scan = scanOptions(args, "o", true);
  return scan.dynamic || scan.names.some(namesGlobSubst) || scan.modes.some((mode) => mode !== "zsh");
}

/**
 * Modes `emulate` turns GLOB_SUBST on for: zsh reads only the first letter after an optional `r`, so `rksh`, `bourne`
 * and `ksh93` count, while `foo` and `rzsh` run as zsh (zsh 5.9).
 */
const EMULATION_RE = /^r?[cksb]/;

/**
 * A command word only known at run time, or one brace expansion or a glob may rewrite (`s{etopt,}`), may stand for any
 * ENABLERS entry, or for `exec` or `env` with an argv0 option, so the words after it are held to all of their checks at once, a superset of what a literal `zsh`,
 * `setopt`, `set` or `emulate` gets; the caller has already read its argv0.
 */
function dynamicCommand(rest: WordToken[]): boolean {
  const emulating = ["exec", "env"].some((wrapper) => argv0Values(wrapper, rest).some(argv0Emulates));
  return emulating || rest.some(unknowable) || Object.values(ENABLERS).some((check) => check(rest));
}
