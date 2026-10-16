import type { WordToken } from "./lexer.js";
import { SOURCERS, STORED_CODE } from "./shell-text-runners.js";
import type { Unwrapped } from "./unwrap.js";

/**
 * Whether a command may turn on zsh's GLOB_SUBST, under which a later unquoted `$x` holding `*(e:CODE:)` runs CODE
 * as a glob qualifier. Both polarities and every spelling zsh accepts count, as does any operand only known at run
 * time, so the reading fails closed: `unsetopt noglobsubst` enables it and `setopt $o` may. So does any command that
 * runs shell text the walk does not read: a sourced file, or `trap` and `alias` text run later.
 */
export function mayEnableGlobSubst(cmd: Unwrapped): boolean {
  if (cmd.assigned.some(([name]) => name === "options") || cmd.args.some(namesOptions)) return true;
  if (cmd.name !== null && (SOURCERS.has(cmd.name) || STORED_CODE.has(cmd.name))) return true;
  const unknownProgram = cmd.name === null || (cmd.path !== null && mayExpand(cmd.path));
  if ((unknownProgram || cmd.name === "zsh") && cmd.argv0?.some(argv0Emulates)) return true;
  if (cmd.name === null) return dynamicCommand(cmd.args.slice(1));
  if (unknownProgram) return dynamicCommand(cmd.args);
  if (writesUnknownTarget(cmd.name, cmd.args)) return true;
  const check = Object.hasOwn(ENABLERS, cmd.name) ? ENABLERS[cmd.name] : undefined;
  return check?.(cmd.args) ?? false;
}

/**
 * `options`, `options[k]=v` or `options+=v`, alone or attached to a short option as in `zparseopts -Aoptions`. Any
 * command may write the parameter such a word names (`strftime -s`, `zstat -A`, `sysread`), so none is trusted.
 */
const OPTIONS_OPERAND_RE = /^(?:-[A-Za-z]*)?options(?:\[|\+?=|$)/;
const OPTIONS_NAME_RE = /^options(?:\[|$)/;
/** A target spelled with a literal name, as in `x=$y` or `x[$k]`, writes that name whatever the rest expands to. */
const NAMED_TARGET_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\[|\+?=)/;
/** Characters brace expansion or filename generation reads, extendedglob's `^`, `#` and `~` included;
 * a leading `~` is tilde expansion instead, safe only bare or as `~/`, since `~name` and `~1` read a named dir or
 * the dirstack. A split quote may leave any of them unquoted. */
const PATTERN_RE = /[{*?[^#]|.~|^~(?!\/|$)/s;
/** `${options[globsubst]::=on}` assigns through an expansion; `refs` hold only plain names, so the text is read too. */
const OPTIONS_EXPANSION_RE = /\$\{[^}]*\boptions\b/;
/**
 * `${(P)n::=on}` assigns the parameter `$n` names, which may be `options[globsubst]`; `=` and `:=` assign too. Nested
 * braces (`${(P)${n}::=on}`) and delimited flag arguments may sit anywhere between, so any `P` after a `${(` flag
 * opener with any `=` after it counts. The text is matched because the lexer keeps no parsed flags; it fails closed.
 */
const INDIRECT_ASSIGN_RE = /\$\{\([^]*?P[^]*=/;

const ENABLERS: Record<string, (args: WordToken[]) => boolean> = {
  setopt: setoptEnables,
  unsetopt: setoptEnables,
  set: setEnables,
  emulate: emulateEnables,
  zsh: zshEnables,
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

function namesOptions(w: WordToken): boolean {
  if (OPTIONS_OPERAND_RE.test(w.value) || w.refs.some((ref) => ref.name === "options")) return true;
  return w.dynamic && (OPTIONS_EXPANSION_RE.test(w.value) || INDIRECT_ASSIGN_RE.test(w.value));
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
  /** Some word is only known at run time or may expand to others. */
  dynamic: boolean;
}

/**
 * Reads option words up to `--`, or up to the first operand when `untilOperand` is set. Each letter of `valued` takes
 * the rest of its cluster or the next word as its value, which `c` drops since that is shell text the walk reads.
 */
function scanOptions(args: WordToken[], valued: string, untilOperand: boolean): OptionScan {
  const scan: OptionScan = { names: [], arrays: [], flags: "", operands: [], modes: [], dynamic: false };
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
  return scan.dynamic || scan.names.some(namesGlobSubst) || scan.arrays.includes("options");
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
 * writer or any ENABLERS entry, so the words after it are held to all of their checks at once, a superset of what a
 * literal `zsh`, `setopt`, `set` or `emulate` gets; the caller has already read its argv0.
 */
function dynamicCommand(rest: WordToken[]): boolean {
  return rest.some((w) => unknownName(w, w.value)) || Object.values(ENABLERS).some((check) => check(rest));
}

interface WriterSpec {
  /** Option letters whose value, attached or in the next word, names the parameter written. */
  targets?: string;
  /** Other option letters that take a value. */
  values?: string;
  /** Which operands name a parameter: every one, or the one at this index. */
  operands?: "all" | number;
  /** Operands are `zparseopts` specs, which name a parameter after their last `=`. */
  specs?: true;
}

const DECLARER_SPEC: WriterSpec = { operands: "all" };

/** Commands that write a parameter they are given by name; a name only known at run time may be `options`. */
const WRITER_SPECS: Record<string, WriterSpec> = {
  print: { targets: "v", values: "CfuxX" },
  printf: { targets: "v" },
  read: { values: "du", operands: "all" },
  vared: { values: "prMmift", operands: 0 },
  getopts: { operands: 1 },
  getln: { operands: "all" },
  local: DECLARER_SPEC,
  export: DECLARER_SPEC,
  declare: DECLARER_SPEC,
  typeset: DECLARER_SPEC,
  readonly: DECLARER_SPEC,
  integer: DECLARER_SPEC,
  float: DECLARER_SPEC,
  zparseopts: { targets: "aA", specs: true },
  zstat: { targets: "AH", values: "fF" },
  stat: { targets: "AH", values: "fF" },
  strftime: { targets: "s" },
  sysread: { targets: "c", values: "iost", operands: 0 },
  zformat: { operands: 0 },
  ztcp: { targets: "v" },
  zsocket: { targets: "v" },
  sysopen: { targets: "u", values: "mo" },
  zselect: { targets: "aA", values: "rwet" },
};

/** A word naming the parameter a command writes, and the text of that name. */
interface Target {
  word: WordToken;
  text: string;
}

/**
 * A command that may write a parameter it is given by name writes `options` when that name is only known at run time.
 * WRITER_SPECS reads known writers more tightly; ENABLERS commands have their own check; NEVER_WRITES are left alone.
 * Any other command may be a zsh builtin or module builtin (`zstyle -s`, `pcre_match -v`, `zpty -r`), so every word
 * of it that is only known at run time and does not start with a literal `name=` or `name[` may be such a name.
 */
function writesUnknownTarget(name: string, args: WordToken[]): boolean {
  const spec = Object.hasOwn(WRITER_SPECS, name) ? WRITER_SPECS[name] : undefined;
  if (spec) return writerTargets(args, spec).some(({ word, text }) => OPTIONS_NAME_RE.test(text) || unknownName(word, text));
  if (Object.hasOwn(ENABLERS, name) || NEVER_WRITES.has(name)) return false;
  return args.some((w) => unknownName(w, w.value));
}

function unknownName(word: WordToken, text: string): boolean {
  return unknowable(word) && !NAMED_TARGET_RE.test(text);
}

/**
 * Commands that never write a shell parameter by name: external programs, which cannot, and builtins whose manual
 * names no parameter they write. Add a name only when it is one of those. Never add a builtin a zsh module loads
 * (`stat`, `zstat`, `zstyle`, `zpty`, `pcre_match`, `zformat`, `sysread`, `strftime`), `read`, `vared`, `getopts`,
 * a declarer, `print`/`printf`, or a command that runs shell text (`eval`, `source`, `.`).
 */
const NEVER_WRITES = new Set([
  // builtins
  ":", "[", "[[", "test", "true", "false", "echo", "pwd", "cd", "pushd", "popd", "dirs", "exit", "return", "wait", "kill",
  "jobs", "type", "which", "whence", "where", "unset", "unalias", "unhash", "umask", "ulimit", "sleep",
  // external programs
  "git", "gh", "grep", "egrep", "rg", "ls", "cat", "head", "tail", "less", "wc", "sort", "uniq", "cut", "tr", "sed",
  "awk", "find", "fd", "curl", "wget", "jq", "yq", "node", "npm", "pnpm", "yarn", "bun", "deno", "python", "python3",
  "pip", "uv", "cargo", "go", "make", "mkdir", "rmdir", "rm", "cp", "mv", "touch", "chmod", "chown", "ln", "diff",
  "patch", "tee", "date", "basename", "dirname", "realpath", "readlink", "tar", "gzip", "gunzip", "zip", "unzip",
  "docker", "ssh", "scp", "rsync", "du", "df", "ps", "file", "xxd", "od", "base64", "shasum", "sha256sum", "md5sum",
  "tsc", "vitest", "eslint", "prettier", "open", "pbcopy", "column", "paste", "comm", "join", "seq", "yes",
]);

/**
 * Option words come first, up to `--` or the first operand. A word starting with `-` or `+` is read as options even
 * when part of it is only known at run time, as in `zstat -H"$n"`; one that may expand to options is not modelled.
 */
function writerTargets(args: WordToken[], spec: WriterSpec): Target[] {
  const out: Target[] = [];
  let operand = -1;
  for (let i = 0; i < args.length; i++) {
    const w = args[i];
    if (w === undefined) break;
    if (operand < 0 && w.value === "--" && !w.dynamic) operand = 0;
    else if (operand < 0 && isOptionWord(w.value)) i = writerCluster(w, args[i + 1], i, spec, out);
    else {
      operand = Math.max(operand, 0);
      out.push(...operandTargets(w, operand++, spec));
    }
  }
  return out;
}

function operandTargets(w: WordToken, index: number, spec: WriterSpec): Target[] {
  if (spec.specs) return [{ word: w, text: w.value.slice(w.value.lastIndexOf("=") + 1) }];
  return spec.operands === "all" || spec.operands === index ? [{ word: w, text: w.value }] : [];
}

/** Reads one option cluster, adding the target a letter of `spec.targets` takes; returns the index of the last word read. */
function writerCluster(w: WordToken, next: WordToken | undefined, i: number, spec: WriterSpec, out: Target[]): number {
  for (let j = 1; j < w.value.length; j++) {
    const letter = w.value.charAt(j);
    const isTarget = spec.targets?.includes(letter) ?? false;
    if (!isTarget && !spec.values?.includes(letter)) continue;
    const attached = w.value.slice(j + 1);
    if (isTarget && attached) out.push({ word: w, text: attached });
    else if (isTarget && next) out.push({ word: next, text: next.value });
    return attached ? i : i + 1;
  }
  return i;
}
