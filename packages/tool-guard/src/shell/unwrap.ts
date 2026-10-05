import type { WordToken } from "./lexer.js";
import { basename } from "./path.js";
import { parseAssignment } from "./vars.js";
import type { Assignment } from "./vars.js";
import { SUDO_LONG_VALUES, spellLongOptions } from "./wrapper-long.js";

interface WrapperSpec {
  /** Options that take a separate value. */
  values?: string[];
  /** Options meaning "does not run the command". */
  stop?: string[];
  /** Positionals before the wrapped command. */
  positionals?: number;
  /** Options whose value is shell text the wrapper runs. */
  script?: string[];
  /** Whether a script option also takes its text attached, as getopt does for `env -S'...'`. */
  attached?: boolean;
  /** Whether the wrapper joins its command words into shell text, as `watch` does, unless given `direct`. */
  joined?: boolean;
  /** Options that make a joining wrapper run its words directly. */
  direct?: string[];
  /** Whether a name word may precede a compound command, as in `coproc NAME { ...; }`. */
  named?: boolean;
}

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "{", "}", "!"]);
const COMPOUND_STARTS = new Set(["{", "if", "while", "until", "for", "case", "select", "[[", "(("]);
const PACKAGE_OPTS: WrapperSpec = { values: ["-p", "--package"], script: ["-c", "--call", "--shell-mode"] };

const WRAPPERS: Record<string, WrapperSpec> = {
  env: { values: ["-u", "--unset", "-C", "--chdir", "--argv0"], script: ["-S", "--split-string"], attached: true },
  command: { stop: ["-v", "-V"] },
  builtin: {},
  exec: { values: ["-a"] },
  nohup: {},
  time: {},
  nice: { values: ["-n", "--adjustment"] },
  sudo: { values: ["-u", "-g", "-p", "-C", "-D", "-h", "-r", "-t", "-U", ...SUDO_LONG_VALUES] },
  timeout: { values: ["-s", "-k", "--signal", "--kill-after"], positionals: 1 },
  // `--eof`, `--max-lines` and `--replace` take their value only after `=`, so they stay out.
  xargs: {
    values: ["-I", "-L", "-n", "-P", "-d", "-E", "-s", "-a", "--max-args", "--delimiter", "--arg-file", "--max-procs", "--max-chars", "--process-slot-var"],
  },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  npx: PACKAGE_OPTS,
  bunx: PACKAGE_OPTS,
  coproc: { named: true },
  setsid: {},
  doas: { values: ["-a", "-u"], stop: ["-C", "-L"] },
  flock: {
    values: ["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"],
    positionals: 1,
    script: ["-c", "--command"],
  },
  watch: {
    values: ["-n", "--interval", "-q", "--equexit", "-s", "--shotsdir"],
    joined: true, direct: ["-x", "--exec"] },
};

const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Package managers that run a command only through a subcommand: `pnpm exec x`, `yarn dlx x`, `npm exec x`. */
const RUNNERS: Record<string, { subs: string[]; values: string[]; shellMode?: boolean }> = {
  pnpm: { subs: ["exec", "dlx"], values: ["--filter", "-F", "-C", "--dir"], shellMode: true },
  yarn: { subs: ["exec", "dlx"], values: ["--cwd"] },
  npm: { subs: ["exec", "x"], values: ["-w", "--workspace", "-C", "--prefix"] },
  bun: { subs: ["x"], values: ["--cwd"] },
};

export interface XargsBatch {
  unit: "lines" | "args";
  size: number | null;
}

export interface Unwrapped {
  /** The command that runs, or null when no word names one statically. */
  name: string | null;
  args: WordToken[];
  /** Leading `NAME=value` words, values null when only known at run time. */
  assigned: Assignment[];
  /** The command word as typed, after literal expansion: `./x.sh`, `/usr/bin/git`; null when `name` is. */
  path: string | null;
  /** Shell text a wrapper option runs (`npx -c`, `env -S`); `name` is then the wrapper. */
  script?: string;
  /** Set when `xargs` runs the command; `replace` is the string `-I` replaces with each input record. */
  xargs?: {
    replace: string | null;
    /** Record separators `-0` and `-d` name; null when a `-d` value cannot be read statically. */
    delimiters: string[] | null;
    /** The `-L`/`-n` batching: how many lines or arguments one run takes; `size` is null when it cannot be read statically. */
    batch: XargsBatch | null;
    /** Every word after xargs's own options: any wrapper it runs, then the command and its arguments. */
    words: WordToken[];
  };
  /** Set when `!` negates the command's status. */
  negated?: true;
}

/** Program name a command word runs: a path's basename, a scoped package whole, any `@version` dropped. */
export function commandName(value: string): string {
  if (value.startsWith("@")) return value.replace(/(?<=\/[^@]*)@.*$/, "");
  return basename(value).replace(/@.*$/, "");
}

/** Strips keywords, assignments and wrappers. Returns null for a wrapper that does not run its command. */
export function unwrap(words: WordToken[]): Unwrapped | null {
  const assigned: Assignment[] = [];
  let xargs: Unwrapped["xargs"];
  let negated = false;
  let i = 0;
  while (i < words.length) {
    const w = words[i] as WordToken;
    const assignment = parseAssignment(w);
    if (KEYWORDS.has(w.value) && !w.quoted) {
      negated ||= w.value === "!";
      i++;
    }
    else if (assignment) {
      assigned.push(assignment);
      i++;
    } else if (!w.dynamic && (wrapperSpec(w.value) || runnerEnd(words, i) > i)) {
      const spelled = spellXargs(words, i, assigned);
      if (!Array.isArray(spelled)) return spelled;
      words = spelled;
      const start = wrapperSpec(w.value) ? i + 1 : runnerEnd(words, i);
      const spec = wrapperSpec(w.value) ?? PACKAGE_OPTS;
      const script =
        runnerShellScript(words, i, start) ?? wrapperScript(words, start, spec) ?? joinedScript(words, start, spec);
      if (script !== null) return { name: commandName(w.value), path: w.value, args: words.slice(i + 1), assigned, script };
      i = skipWrapper(words, start, spec);
      if (i < 0) return null;
      if (commandName(w.value) === "xargs") xargs = { ...xargsOptions(words.slice(start, i), xargs), words: words.slice(i) };
    } else break;
  }
  return { ...command(words, i, assigned), ...(xargs ? { xargs } : {}), ...(negated ? { negated } : {}) };
}

function command(words: WordToken[], i: number, assigned: Unwrapped["assigned"]): Unwrapped {
  const first = words[i];
  if (!first) return { name: null, path: null, args: [], assigned };
  if (first.dynamic) return { name: null, path: null, args: words.slice(i), assigned };
  return { name: commandName(first.value), path: first.value, args: words.slice(i + 1), assigned };
}

/** `words` with the long options of a wrapper at `i` spelled out; an ambiguous one is read both ways instead. */
function spellXargs(words: WordToken[], i: number, assigned: Unwrapped["assigned"]): WordToken[] | Unwrapped {
  const name = commandName((words[i] as WordToken).value);
  const spelled = spellLongOptions(name, words, i + 1, (v) => takesValue(v, wrapperSpec(name)?.values));
  if (typeof spelled !== "number") return spelled;
  return { ...command(words, i, assigned), script: ambiguousReadings(words, i, spelled) };
}

/**
 * A wrapper refuses an ambiguous prefix, but which word is the command depends on whether it takes a value,
 * so both readings run as script text and either one can block.
 */
function ambiguousReadings(words: WordToken[], i: number, at: number): string {
  const kept = words.slice(i, at);
  return [words.slice(at + 1), words.slice(at + 2)].map((rest) => scriptText("", [...kept, ...rest])).join("\n");
}

function xargsOptions(options: WordToken[], earlier: Unwrapped["xargs"]): Omit<NonNullable<Unwrapped["xargs"]>, "words"> {
  const found = xargsDelimiters(options);
  const before = earlier?.delimiters;
  const delimiters = found === null || before === null ? null : [...(before ?? []), ...found];
  const batch = xargsBatch(options) ?? earlier?.batch ?? null;
  return { replace: xargsReplace(options) ?? earlier?.replace ?? null, delimiters, batch };
}

function batchSize(word: WordToken | undefined, text: string | undefined = word?.value): number | null {
  if (!word || (text === word.value && word.dynamic) || !/^\d+$/.test(text ?? "")) return null;
  return Number(text) > 0 ? Number(text) : null;
}

/** The last `-L N`, `-lN`, `--max-lines[=N]`, `-n N`, `--max-args N` or a cluster such as `-rL1`; a bare `-l` or `--max-lines` means one line. */
function xargsBatch(options: WordToken[]): XargsBatch | null {
  let found: XargsBatch | null = null;
  options.forEach((word, j) => {
    const v = word.value;
    const next = options[j + 1];
    if (v === "--max-lines") found = { unit: "lines", size: 1 };
    else if (v === "--max-args") found = { unit: "args", size: batchSize(next) };
    else if (v.startsWith("--max-lines=")) found = { unit: "lines", size: batchSize(word, v.slice("--max-lines=".length)) };
    else if (v.startsWith("--max-args=")) found = { unit: "args", size: batchSize(word, v.slice("--max-args=".length)) };
    else if (/^-[A-Za-z]/.test(v) && !v.startsWith("--")) found = clusterBatch(word, next) ?? found;
  });
  return found;
}

/** The `-L`, `-l` or `-n` option in a short cluster; an option that takes a value ends the scan, as the value is the rest of the word. */
function clusterBatch(word: WordToken, next: WordToken | undefined): XargsBatch | null {
  const v = word.value;
  for (let k = 1; k < v.length; k++) {
    const c = v[k] as string;
    const rest = v.slice(k + 1);
    if (c === "l") return { unit: "lines", size: rest ? batchSize(word, rest) : 1 };
    if (c === "L" || c === "n") return { unit: c === "L" ? "lines" : "args", size: rest ? batchSize(word, rest) : batchSize(next) };
    if (c === "i" || c === "e" || WRAPPERS.xargs?.values?.includes(`-${c}`)) return null;
  }
  return null;
}

const DELIMITER_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\" };

/** The separator a `-d` value names: one character or a C escape; null when dynamic or longer. */
function delimiterOf(word: WordToken | undefined, text?: string): string | null {
  if (!word || (text === undefined && word.dynamic)) return null;
  const v = text ?? word.value;
  if (v.length === 1) return v;
  return v.length === 2 && v[0] === "\\" ? (DELIMITER_ESCAPES[v[1] as string] ?? null) : null;
}

/** The record separators of `-0`, `--null`, `-d c`, `-dc`, `--delimiter=c` or a cluster such as `-t0`; null if one is unreadable. */
function xargsDelimiters(options: WordToken[]): string[] | null {
  const out: string[] = [];
  for (let j = 0; j < options.length; j++) {
    const v = (options[j] as WordToken).value;
    if (v === "--null") out.push("\0");
    else if (v === "--delimiter") out.push(delimiterOf(options[++j]) ?? "");
    else if (v.startsWith("--delimiter=")) out.push(delimiterOf(options[j], v.slice("--delimiter=".length)) ?? "");
    else if (/^-[A-Za-z0]/.test(v)) j = clusterDelimiters(options, j, out);
  }
  return out.includes("") ? null : out;
}

/** Reads the `0` and `d` options of the cluster at `j`; returns the index of the last word it used. */
function clusterDelimiters(options: WordToken[], j: number, out: string[]): number {
  const v = (options[j] as WordToken).value;
  for (let k = 1; k < v.length; k++) {
    if (v[k] === "0") out.push("\0");
    else if (v[k] === "d") {
      const rest = v.slice(k + 1);
      out.push((rest ? delimiterOf(options[j], rest) : delimiterOf(options[j + 1])) ?? "");
      return rest ? j : j + 1;
    } else if (WRAPPERS.xargs?.values?.includes(`-${v[k]}`)) return v.length > k + 1 ? j : j + 1;
  }
  return j;
}

/** The replace string of `-I str`, `-Istr`, `-i[str]`, `--replace[=str]` or a cluster such as `-tI{}`, `{}` when none is given. */
function xargsReplace(options: WordToken[]): string | null {
  let replace: string | null = null;
  options.forEach((word, j) => {
    const v = word.value;
    if (v === "--replace") replace = "{}";
    else if (v.startsWith("--replace=")) replace = v.slice("--replace=".length);
    else if (/^-[A-Za-z]/.test(v)) replace = clusterReplace(v, options[j + 1]?.value) ?? replace;
  });
  return replace;
}

/** The replace string a short-option cluster sets: the text after `I` or `i`, else the next word for `I` and `{}` for `i`. */
function clusterReplace(v: string, next: string | undefined): string | null {
  for (let k = 1; k < v.length; k++) {
    const rest = v.slice(k + 1);
    if (v[k] === "I") return rest || (next ?? null);
    if (v[k] === "i") return rest || "{}";
    if (WRAPPERS.xargs?.values?.includes(`-${v[k]}`)) return null;
  }
  return null;
}

/** Whether option word `v` takes the next word as its value: `-I`, or a cluster ending in one, `-tI`. */
function takesValue(v: string, values: string[] = []): boolean {
  if (values.includes(v)) return true;
  if (!/^-[A-Za-z]{2,}$/.test(v)) return false;
  return [...v.slice(1)].findIndex((c) => values.includes(`-${c}`)) === v.length - 2;
}

function wrapperSpec(value: string): WrapperSpec | undefined {
  const name = commandName(value);
  return Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
}

function skipWrapper(words: WordToken[], i: number, spec: WrapperSpec): number {
  while (i < words.length && (words[i] as WordToken).value.startsWith("-")) {
    const v = (words[i] as WordToken).value;
    if (spec.stop?.includes(v)) return -1;
    i += takesValue(v, spec.values) ? 2 : 1;
    if (v === "--") break;
  }
  if (spec.named && isCompoundStart(words[i + 1])) return i + 1;
  return i + (spec.positionals ?? 0);
}

function isCompoundStart(word: WordToken | undefined): boolean {
  return word !== undefined && !word.quoted && COMPOUND_STARTS.has(word.value);
}

/** Shell text given to one of `spec.script`'s options, before or after the positionals (`flock <file> -c`). */
function wrapperScript(words: WordToken[], i: number, spec: WrapperSpec): string | null {
  while (i < words.length && (words[i] as WordToken).value.startsWith("-")) {
    const v = (words[i] as WordToken).value;
    const at = scriptOption(v, spec);
    if (at === "next") return scriptText(words[i + 1]?.value ?? "", words.slice(i + 2));
    if (at !== null) return scriptText(at.attached, words.slice(i + 1));
    if (v === "--") break;
    i += takesValue(v, spec.values) ? 2 : 1;
  }
  if (!spec.positionals || !spec.script) return null;
  return wrapperScript(words, i + spec.positionals, { ...spec, positionals: 0 });
}

/** `watch git push`: the words after the options, joined by spaces, are shell text. */
function joinedScript(words: WordToken[], start: number, spec: WrapperSpec): string | null {
  if (!spec.joined) return null;
  const end = skipWrapper(words, start, spec);
  if (words.slice(start, end).some((w) => isDirect(w.value, spec.direct ?? [])) || end >= words.length) return null;
  return words
    .slice(end)
    .map((w) => w.value)
    .join(" ");
}

/** Whether `v` is one of `direct`, alone or inside a short cluster such as `-tx`. */
function isDirect(v: string, direct: string[]): boolean {
  if (direct.includes(v)) return true;
  return /^-[A-Za-z]+$/.test(v) && direct.some((d) => /^-[A-Za-z]$/.test(d) && v.includes(d.slice(1)));
}

/** Where a script option's text sits: attached to `v`, or in the next word. Null when `v` is no script option. */
function scriptOption(v: string, spec: WrapperSpec): { attached: string } | "next" | null {
  const eq = v.startsWith("--") ? v.indexOf("=") : -1;
  if (eq > 0) return spec.script?.includes(v.slice(0, eq)) ? { attached: v.slice(eq + 1) } : null;
  if (spec.script?.includes(v)) return "next";
  if (v.startsWith("--")) return null;
  for (let j = 1; j < v.length; j++) {
    const flag = `-${v[j]}`;
    if (spec.script?.includes(flag)) {
      if (j === v.length - 1) return "next";
      return spec.attached ? { attached: v.slice(j + 1) } : null;
    }
    if (spec.values?.includes(flag)) return null;
  }
  return null;
}

/** `pnpm -c exec 'cmd'`: pnpm's global shell mode makes the word after `exec` a script. */
function runnerShellScript(words: WordToken[], i: number, start: number): string | null {
  const name = commandName((words[i] as WordToken).value);
  if (!Object.hasOwn(RUNNERS, name) || !RUNNERS[name]?.shellMode) return null;
  const globals = words.slice(i + 1, start - 1).map((w) => w.value);
  const shellMode = globals.some((v) => v === "--shell-mode" || /^-[A-Za-z]*c[A-Za-z]*$/.test(v));
  return shellMode ? scriptText(words[start]?.value ?? "", words.slice(start + 1)) : null;
}

function scriptText(text: string, rest: WordToken[]): string {
  return [text, ...rest.map((r) => `'${r.value.replaceAll("'", "'\\''")}'`)].join(" ");
}

/** Index just past `pnpm [opts] exec` and the like, or `i` when the word at `i` is not such a runner. */
function runnerEnd(words: WordToken[], i: number): number {
  const name = commandName((words[i] as WordToken).value);
  const spec = Object.hasOwn(RUNNERS, name) ? RUNNERS[name] : undefined;
  if (!spec) return i;
  const sub = skipWrapper(words, i + 1, { values: spec.values });
  const subWord = words[sub];
  if (!subWord || subWord.dynamic || !spec.subs.includes(subWord.value)) return i;
  return sub + 1;
}

/** The command words of each `find -exec`, `-execdir`, `-ok` and `-okdir`, without their terminator. */
export function findExecs(args: WordToken[]): WordToken[][] {
  const out: WordToken[][] = [];
  for (let i = 0; i < args.length; i++) {
    if (!FIND_EXEC.has((args[i] as WordToken).value)) continue;
    const end = execEnd(args, i + 1);
    out.push(args.slice(i + 1, end));
    i = end;
  }
  return out;
}

/** Index of the `;` that ends an exec, or of a `+` right after `{}`; the end of `args` when neither comes. */
function execEnd(args: WordToken[], i: number): number {
  for (let j = i; j < args.length; j++) {
    const v = (args[j] as WordToken).value;
    if (v === ";" || (v === "+" && j > i && args[j - 1]?.value === "{}")) return j;
  }
  return args.length;
}
