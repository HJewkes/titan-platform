import { ParseError, tokenize } from "./lexer.js";
import type { RedirectToken, Token, WordToken } from "./lexer.js";
import { resolvePath } from "./path.js";
import { printedText } from "./printed.js";
import { findExecs, type Unwrapped, type XargsBatch } from "./unwrap.js";
import { caseNamed, caseScripts } from "./case-script.js";
import { assign, childVars, expandWord, lookup, noteSureCommands, trackCompound, trackVars } from "./vars.js";
import { normalizeDeclarations } from "./declarations.js";
import { pipedShellTexts } from "./piped-nul.js";
import { xargsCommands } from "./xargs-runs.js";
import type { Vars } from "./vars.js";

const MAX_DEPTH = 8;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SHELL_VALUE_OPTS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);

/**
 * How a command was reached: a `( )` subshell or a substitution, a shell's `-c` string or a wrapper's
 * script option, `eval`, `xargs`, a heredoc or here-string fed to a shell, text piped into one, `find -exec`.
 */
export type Wrapping = "subshell" | "sh-c" | "eval" | "xargs" | "heredoc-shell" | "piped-shell" | "find-exec";

/** A run of commands joined only by `&&`; any other operator, a group or a nested list starts a new one. Compared by identity. */
export interface Chain {
  /** The operator before the run's first command, null at the start of a list. */
  readonly start: string | null;
}

/** One simple command the shell would run. */
export interface SimpleCommand {
  /** Null when no word names the command statically: only assignments or redirections, or a dynamic first word. */
  name: string | null;
  /** The command word as typed, after literal expansion (`./x.sh`, `~/bin/x`); null when `name` is. */
  path: string | null;
  args: WordToken[];
  /** Literal `NAME=value` prefixes. */
  env: Record<string, string>;
  redirects: RedirectToken[];
  /** Working directory, null when it cannot be known. */
  dir: string | null;
  /** The wrappings that reached the command, outermost first; empty at the top level. */
  wrapping: Wrapping[];
  /** The operator joining the command to the next on its list (`&&`, `||`, `;`, `\n`, `|`, `&`), null when none follows. */
  next: string | null;
  /** The operator joining the previous command on its list to this one, null when none precedes. */
  prev: string | null;
  /** Whether `!` negates the status of the pipeline the command is in. */
  negated: boolean;
  chain: Chain;
}

export interface ExtractOptions {
  cwd?: string | null;
  /** Expands `~`, `$HOME` and a bare `cd`; null leaves them unknown. */
  home?: string | null;
}

interface Scope {
  dir: string | null;
  vars: Vars;
  wrapping: Wrapping[];
}

/** Shell text a command runs, and how it reaches the commands in it. */
interface Inline {
  texts: string[];
  wrap: Wrapping;
}

interface Walk {
  scope: Scope;
  stack: Scope[];
  out: SimpleCommand[];
  home: string | null;
  depth: number;
  /** Literal text piped into the command being emitted, as `echo 'git push' | bash` does. */
  stdin: string | null;
  /** The operator before the command being emitted. */
  prev: string | null;
  chain: Chain;
  /** Whether `!` negates the pipeline the command being emitted belongs to. */
  negated: boolean;
}

/**
 * Every simple command the shell would run, including ones nested in substitutions, `bash -c`
 * strings, `eval` and heredocs fed to a shell. Literal variable assignments are expanded into
 * later words. Throws `ParseError`.
 */
export function extractCommands(src: string, options: ExtractOptions = {}): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  const scope = { dir: options.cwd ?? null, vars: new Map(), wrapping: [] };
  walk(tokenize(src), { scope, stack: [], out, home: options.home ?? null, depth: 0, stdin: null, prev: null, chain: { start: null }, negated: false });
  return out;
}

function walk(tokens: Token[], w: Walk): void {
  if (w.depth > MAX_DEPTH) throw new ParseError("nesting too deep");
  let words: WordToken[] = [];
  let redirects: RedirectToken[] = [];
  for (const token of noteSureCommands(normalizeDeclarations(tokens))) {
    if (token.type === "op") {
      const cmd = emit(words, redirects, w, token.value);
      w.stdin = nextStdin(token.value, cmd, words.length + redirects.length === 0, w.stdin);
      words = [];
      redirects = [];
      w.prev = token.value;
      if (token.value !== "|" && token.value !== "|&") w.negated = false;
      if (token.value !== "&&") w.chain = { start: token.value };
      trackCompound(token, w.scope.vars);
      scope(token.value, w);
      continue;
    }
    if (token.type === "word") words.push(token);
    if (token.type === "redirect") redirects.push(token);
    for (const sub of nestedLists(token)) walk(sub, child(w, [...w.scope.wrapping, "subshell"]));
  }
  emit(words, redirects, w, null);
}

/** Text piped into the next command: printed by this one, passed on by `tee` or `cat`, or kept across a bare `(`. */
function nextStdin(op: string, cmd: Unwrapped | null, empty: boolean, stdin: string | null): string | null {
  if (op === "(" && empty) return stdin;
  if (!cmd || (op !== "|" && op !== "|&")) return null;
  return printedText(cmd.name, cmd.args) ?? (passesThrough(cmd) ? stdin : null);
}

function passesThrough(cmd: Unwrapped): boolean {
  if (cmd.name === "tee") return true;
  if (cmd.name !== "cat") return false;
  const operands = catOperands(cmd.args.map((a) => a.value));
  return operands.length === 0 || operands.includes("-");
}

function catOperands(values: string[]): string[] {
  const end = values.indexOf("--");
  const options = end < 0 ? values : values.slice(0, end);
  const operands = options.filter((v) => v === "-" || !v.startsWith("-"));
  return end < 0 ? operands : [...operands, ...values.slice(end + 1)];
}

function nestedLists(token: Token): Token[][] {
  if (token.type === "redirect") return [...(token.target?.subs ?? []), ...token.subs];
  return token.type === "op" ? [] : token.subs;
}

function child(w: Walk, wrapping: Wrapping[]): Walk {
  const scope = { dir: w.scope.dir, vars: childVars(w.scope.vars), wrapping };
  return { ...w, scope, stack: [], depth: w.depth + 1, stdin: null, prev: null, chain: { start: null }, negated: false };
}

function scope(op: string, w: Walk): void {
  if (op === "(") {
    w.stack.push(w.scope);
    w.scope = { dir: w.scope.dir, vars: new Map(w.scope.vars), wrapping: [...w.scope.wrapping, "subshell"] };
  }
  if (op === ")") w.scope = w.stack.pop() ?? w.scope;
}

function emit(rawWords: WordToken[], rawRedirects: RedirectToken[], w: Walk, next: string | null): Unwrapped | null {
  const expand = (word: WordToken) => expandWord(word, (name) => lookup(w.scope.vars, w.home, name));
  const redirects = rawRedirects.map((r) => (r.target ? { ...r, target: expand(r.target) } : r));
  const runs = caseNamed(rawWords.map(expand));
  for (const cmd of runs) run(cmd, redirects, w, next);
  return runs[0] ?? null;
}

function run(raw: Unwrapped, redirects: RedirectToken[], w: Walk, next: string | null): void {
  if (raw.name === null && raw.args.length === 0 && !raw.xargs?.words.length) {
    for (const assignment of raw.assigned) assign(w.scope.vars, assignment);
    if (redirects.length === 0) return;
  }
  if (raw.name === "cd" || raw.name === "pushd") {
    w.scope.dir = changeDir(w.scope.dir, raw.args.find((a) => a.value === "-" || !a.value.startsWith("-")), w.home);
    return;
  }
  const stdin = raw.xargs ? xargsStdin(redirects, w.stdin) : w.stdin;
  for (const cmd of xargsCommands(raw, stdin, (cmd) => xargsRuns(cmd, stdin))) runOnce(cmd, redirects, w, next, stdin);
}

function runOnce(cmd: Unwrapped, redirects: RedirectToken[], w: Walk, next: string | null, stdin: string | null): void {
  trackVars(cmd, w.scope.vars);
  const wrapping: Wrapping[] = cmd.xargs ? [...w.scope.wrapping, "xargs"] : w.scope.wrapping;
  const { name, path, args } = cmd;
  w.negated ||= cmd.negated === true;
  const links = { next, prev: w.prev, negated: w.negated, chain: w.chain };
  w.out.push({ name, path, args, env: literalEnv(cmd), redirects, dir: w.scope.dir, wrapping, ...links });
  const script = inlineScript(cmd, redirects, stdin);
  if (script !== null) for (const text of script.texts) walk(tokenize(text), child(w, [...wrapping, script.wrap]));
  if (cmd.name !== "find") return;
  for (const exec of findExecs(cmd.args).flatMap((words) => caseNamed(words))) run(exec, [], child(w, [...wrapping, "find-exec"]), null);
}

/** A stdin redirect replaces the pipe; a file or descriptor it names has unknown text. */
function xargsStdin(redirects: RedirectToken[], piped: string | null): string | null {
  const feeds = redirects.some((r) => (r.fd === null || r.fd === "0") && ["<", "<<", "<<-", "<<<", "<&"].includes(r.op));
  return feeds ? stdinScript(redirects) : piped;
}

/** The argument lists `xargs` runs the command with: one per input line under a replace string, one per `-L`/`-n` batch, else one with the piped words appended. */
function xargsRuns(cmd: Unwrapped, stdin: string | null): WordToken[][] {
  if (!cmd.xargs) return [cmd.args];
  const { replace, delimiters, batch } = cmd.xargs;
  const shell = cmd.name !== null && SHELLS.has(cmd.name);
  if (stdin === null) return unknownRuns(cmd, replace);
  if (replace !== null) return inputRecords(stdin, delimiters).flatMap((line) => lineRuns(cmd.args, replace, line, !shell));
  // A shell's operands are not appended: a bare `-c` already runs the piped text as its string.
  if (shell) return [cmd.args];
  return inputReadings(stdin, delimiters)
    .flatMap((lines) => batches(stdin, lines, batch))
    .map((words) => [...cmd.args, ...words.map(literalWord)]);
}

const WORST_CASE: Record<string, string[]> = { git: ["push", "origin", "HEAD:main"], gh: ["pr", "merge", "1"] };

/** Input that cannot be read: a protected utility is also read with its worst case, as the replace string or as appended words, so it fails closed. */
function unknownRuns(cmd: Unwrapped, replace: string | null): WordToken[][] {
  const worst = WORST_CASE[cmd.name ?? ""];
  if (!worst) return [cmd.args];
  if (replace === null) return [cmd.args, [...cmd.args, ...worst.map(literalWord)]];
  if (cmd.args[0]?.value !== replace) return [cmd.args];
  return [cmd.args, [...worst.map(literalWord), ...cmd.args.slice(1)]];
}

const MAX_RUN = 16;

/**
 * The word groups one `xargs` run each takes. Quoted input or an unreadable size shifts the real
 * boundaries, so every contiguous run of up to MAX_RUN words is read, plus all words together.
 */
function batches(stdin: string, lines: string[][], batch: XargsBatch | null): string[][] {
  const all = lines.flat();
  if (batch === null) return [all];
  if (batch.size === null || /["'\\]/.test(stdin)) return [all, ...contiguousRuns(all.map((w) => w.replace(/["'\\]/g, "")))];
  const units = batch.unit === "lines" ? lines : all.map((w) => [w]);
  const size = batch.size;
  const groups = Array.from({ length: Math.ceil(units.length / size) }, (_, i) => units.slice(i * size, (i + 1) * size).flat());
  return groups.length > 1 ? [all, ...groups] : groups.length === 1 ? groups : [[]];
}

/**
 * The ways the input may split into lines of words. Blanks split it unless `-0`/`-d` name separators,
 * which then end each record and nothing else; an unreadable `-d` adds a reading per character of the input, so it fails closed.
 */
function inputReadings(stdin: string, delimiters: string[] | null): string[][][] {
  const blanks = logicalLines(stdin).map(wordsOf).filter((l) => l.length > 0);
  if (delimiters !== null && delimiters.length === 0) return [blanks];
  if (delimiters !== null) return [delimitedRecords(stdin, delimiters)];
  return [blanks, ...[...new Set(stdin)].map((c) => delimitedRecords(stdin, [c]))];
}

/** One argument per record; a trailing newline, as `echo` leaves, is dropped so the last record still reads as typed. */
function delimitedRecords(stdin: string, delimiters: string[]): string[][] {
  return splitOn(stdin, delimiters).map((r) => [r.replace(/\r?\n$/, "")]);
}

/** Lines as `-L` counts them: a line ending in a blank continues onto the next. */
function logicalLines(stdin: string): string[] {
  return stdin.split(/\r?\n/).reduce<string[]>((out, line, i) => {
    const prev = out[out.length - 1];
    if (i > 0 && prev !== undefined && /[ \t]$/.test(prev)) out[out.length - 1] = prev + line;
    else out.push(line);
    return out;
  }, []);
}

function contiguousRuns(words: string[]): string[][] {
  const runs: string[][] = [];
  for (let i = 0; i < words.length; i++) for (let n = 1; n <= MAX_RUN && i + n <= words.length; n++) runs.push(words.slice(i, i + n));
  return runs;
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Non-empty input records. A line ends at a newline or NUL; each `-d` separator also splits it, and an
 * unreadable `-d` splits on every character of the input in turn, letters and spaces included. Extra splits only add commands to classify.
 */
function inputRecords(stdin: string, delimiters: string[] | null): string[] {
  const separators = delimiters ?? [...new Set(stdin)];
  const splits = [["\n", "\0"], ...separators.map((d) => [d])].map((seps) => splitOn(stdin, [...seps, "\n", "\0"]));
  const records = [...new Set(splits.flat())];
  return records.length > 0 ? records : [""];
}

function splitOn(text: string, separators: string[]): string[] {
  const escaped = separators.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.split(new RegExp(`\r?(?:${escaped.join("|")})`)).filter((r) => r.trim() !== "");
}

/** The exact reading of a line (one word), plus a split reading when a bare replace string could hold several words. */
function lineRuns(args: WordToken[], replace: string, line: string, split: boolean): WordToken[][] {
  const exact = args.map((a) => (a.value.includes(replace) ? { ...a, value: a.value.replaceAll(replace, line) } : a));
  const words = line.split(/\s+/).filter(Boolean);
  if (!split || words.length < 2 || !args.some((a) => a.value === replace)) return [exact];
  const spread = args.flatMap((a, i) => (a.value === replace ? words.map(literalWord) : [exact[i] as WordToken]));
  return [exact, spread];
}

function literalWord(value: string): WordToken {
  return { type: "word", value, dynamic: false, quoted: false, spliced: false, computed: false, refs: [], subs: [] };
}

function literalEnv(cmd: Unwrapped): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value, kind] of cmd.assigned) if (value !== null && !kind) env[name] = value;
  return env;
}

/** The script a shell or `eval` runs: a `-c` string, else a heredoc, here-string or literal pipe on stdin. */
function inlineScript(cmd: Unwrapped, redirects: RedirectToken[], stdin: string | null): Inline | null {
  if (cmd.script !== undefined) return { texts: [cmd.script], wrap: "sh-c" };
  if (cmd.name === "eval") return { texts: caseScripts(cmd.args), wrap: "eval" };
  if (cmd.name === null || !SHELLS.has(cmd.name)) return null;
  const { hasC, positional } = shellOperands(cmd.args);
  // A bare `-c` takes the pipe too: `xargs sh -c` turns the piped text into the string.
  const text = hasC ? (positional ? caseScripts([positional]) : stdin) : positional ? null : stdinScript(redirects);
  if (text !== null) return { texts: [text].flat(), wrap: hasC ? "sh-c" : "heredoc-shell" };
  return hasC || positional || stdin === null ? null : { texts: pipedShellTexts(cmd.name, stdin), wrap: "piped-shell" };
}

function shellOperands(args: WordToken[]): { hasC: boolean; positional: WordToken | null } {
  let hasC = false;
  for (let i = 0; i < args.length; i++) {
    const v = (args[i] as WordToken).value;
    if (v === "-") break;
    if (v === "--") return { hasC, positional: args[i + 1] ?? null };
    if (SHELL_VALUE_OPTS.has(v)) i++;
    else if (v.startsWith("--")) continue;
    else if (/^[-+][A-Za-z]+$/.test(v)) hasC ||= v.startsWith("-") && v.includes("c");
    else return { hasC, positional: args[i] as WordToken };
  }
  return { hasC, positional: null };
}

function stdinScript(redirects: RedirectToken[]): string | null {
  const feed = [...redirects].reverse().find((r) => r.body !== null || r.op === "<<<");
  if (!feed) return null;
  return feed.body ?? feed.target?.value ?? null;
}

function changeDir(dir: string | null, word: WordToken | undefined, home: string | null): string | null {
  if (!word) return home;
  return word.value === "-" ? null : resolvePath(dir, word, home);
}
