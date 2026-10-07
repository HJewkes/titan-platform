import { ParseError, tokenize } from "./lexer.js";
import type { RedirectToken, Token, WordToken } from "./lexer.js";
import { resolvePath } from "./path.js";
import { printedText } from "./printed.js";
import { findExecs, type Unwrapped } from "./unwrap.js";
import { caseNamed, caseScripts } from "./case-script.js";
import { foldCommandWords } from "./case-literal.js";
import { assign, childVars, expandWord, lookup, noteSureCommands, trackCompound, trackVars } from "./vars.js";
import { normalizeDeclarations } from "./declarations.js";
import { cutReading, pipedShellTexts } from "./piped-nul.js";
import { addRedirect, groupStdin } from "./group-stdin.js";
import { xargsCommands } from "./xargs-runs.js";
import { runReadings } from "./xargs-readings.js";
import type { Vars } from "./vars.js";

const MAX_DEPTH = 8;
const MAX_UNSURE_WORDS = 512;
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
  /** Set on a command only an added xargs reading runs; it may add actions but never fails the line or moves its state. */
  added?: true;
}

export interface ExtractOptions {
  cwd?: string | null;
  /** Expands `~`, `$HOME` and a bare `cd`; null leaves them unknown. */
  home?: string | null;
  /** Reads every command word lower-cased, as a filesystem that finds `GIT` as git runs it; arguments stay as written. */
  foldCase?: boolean;
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
  foldCase: boolean;
  /** Script texts the readings of the command being emitted have walked, so a later reading walks each text once; null outside one. */
  walked: Set<string> | null;
  /** Words the whole line's `unsure` readings may still walk, shared by every walk of the line. */
  unsureBudget: { left: number };
}

/**
 * Every simple command the shell would run, including ones nested in substitutions, `bash -c`
 * strings, `eval` and heredocs fed to a shell. Literal variable assignments are expanded into
 * later words. Throws `ParseError`.
 */
export function extractCommands(src: string, options: ExtractOptions = {}): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  const scope = { dir: options.cwd ?? null, vars: new Map(), wrapping: [] };
  const foldCase = options.foldCase === true;
  walk(tokenize(src), { scope, stack: [], out, home: options.home ?? null, depth: 0, stdin: null, prev: null, chain: { start: null }, negated: false, foldCase, walked: null, unsureBudget: { left: MAX_UNSURE_WORDS } });
  return out;
}

function walk(tokens: Token[], w: Walk): void {
  if (w.depth > MAX_DEPTH) throw new ParseError("nesting too deep");
  let words: WordToken[] = [];
  let redirects: RedirectToken[] = [];
  for (const token of noteSureCommands(normalizeDeclarations(tokens))) {
    if (token.type === "op") {
      const cmd = emit(words, redirects, w, token.value);
      w.stdin = groupStdin(w, token.value, words, redirects, cmd, nextStdin(token.value, cmd, words.length + redirects.length === 0, w.stdin));
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
    redirects = addRedirect(redirects, token);
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
  return { ...w, scope, stack: [], depth: w.depth + 1, stdin: null, prev: null, chain: { start: null }, negated: false, walked: null };
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
  const words = folded(rawWords.map(expand), w);
  const runs = caseNamed(words);
  const cut = cutReading(words);
  w.walked = new Set();
  for (const cmd of [...runs, ...(cut ? caseNamed(cut) : [])]) run(cmd, redirects, w, next);
  runUnsure(runs[0], redirects, w, next);
  w.walked = null;
  return runs[0] ?? null;
}

/**
 * Reads a command's `unsure` words as an added reading, then theirs in turn, since each wrapper may hide its own
 * dynamic word (`sudo $a timeout $O 5 git push`). Classifying costs about 50 ms per KiB of words, and ten times that
 * for a dynamic command word, so the line shares one budget of MAX_UNSURE_WORDS. Past MAX_DEPTH steps or the budget
 * only two more readings are walked: the last whose command word is still dynamic, and the last, with every such
 * word dropped. Each costs no more than the command as written, a deep chain still reaches its command, and nothing else is lost.
 */
function runUnsure(cmd: Unwrapped | undefined, redirects: RedirectToken[], w: Walk, next: string | null): void {
  const late = new Map<"dynamic" | "last", Unwrapped[]>();
  const budget = w.unsureBudget;
  let unsure = cmd?.unsure;
  for (let depth = 0; unsure; depth++) {
    const runs = caseNamed(unsure);
    if (depth < MAX_DEPTH && unsure.length <= budget.left) {
      budget.left -= unsure.length;
      walkAdded(runs, redirects, w, next);
    } else {
      if (runs[0]?.name === null) late.set("dynamic", runs);
      late.set("last", runs);
    }
    unsure = runs[0]?.unsure;
  }
  for (const runs of new Set(late.values())) walkAdded(runs, redirects, w, next);
}

function walkAdded(runs: Unwrapped[], redirects: RedirectToken[], w: Walk, next: string | null): void {
  addedReading(w, (copy) => runs.forEach((reading) => run(reading, redirects, copy, next)));
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
  const runs = runReadings(stdin, (name) => name !== null && SHELLS.has(name));
  for (const cmd of xargsCommands(raw, stdin, runs.main)) runOnce(cmd, redirects, w, next, stdin);
  if (raw.xargs) for (const cmd of xargsCommands(raw, stdin, runs.added)) runAdded(cmd, redirects, w, next, stdin);
}

/**
 * A reading xargs added beside main's may only add commands: it walks a copy of the variables, so it cannot rebind one main's
 * reading set, an error drops what is left of it, and every command it emits is marked `added` for the classifier to drop on error.
 */
function runAdded(cmd: Unwrapped, redirects: RedirectToken[], w: Walk, next: string | null, stdin: string | null): void {
  addedReading(w, (copy) => runOnce(cmd, redirects, copy, next, stdin));
}

/** Walks a reading on a copy of the scope, so a `cd` or an assignment in it moves nothing, and marks what it emits `added`. */
function addedReading(w: Walk, read: (copy: Walk) => void): void {
  const start = w.out.length;
  try {
    read({ ...w, scope: { ...w.scope, vars: new Map(w.scope.vars) } });
  } catch {
    // Main's runs of the same command still decide; this reading is dropped.
  } finally {
    for (let i = start; i < w.out.length; i++) w.out[i] = { ...(w.out[i] as SimpleCommand), added: true };
  }
}

function runOnce(cmd: Unwrapped, redirects: RedirectToken[], w: Walk, next: string | null, stdin: string | null): void {
  trackVars(cmd, w.scope.vars);
  const wrapping: Wrapping[] = cmd.xargs ? [...w.scope.wrapping, "xargs"] : w.scope.wrapping;
  const { name, path, args } = cmd;
  w.negated ||= cmd.negated === true;
  const links = { next, prev: w.prev, negated: w.negated, chain: w.chain };
  w.out.push({ name, path, args, env: literalEnv(cmd), redirects, dir: w.scope.dir, wrapping, ...links });
  const script = inlineScript(cmd, redirects, stdin);
  if (script !== null) walkScript(script, w, wrapping);
  if (cmd.name !== "find") return;
  for (const exec of findExecs(cmd.args).flatMap((words) => caseNamed(folded(words, w)))) run(exec, [], child(w, [...wrapping, "find-exec"]), null);
}

/** Two readings of one command often run the same script (`flock $F sh -c '...'`); walking it again per nesting level would double the cost. */
function walkScript(script: Inline, w: Walk, wrapping: Wrapping[]): void {
  for (const text of script.texts) {
    if (w.walked?.has(text)) continue;
    w.walked?.add(text);
    walk(tokenize(text), child(w, [...wrapping, script.wrap]));
  }
}

function folded(words: WordToken[], w: Walk): WordToken[] {
  return w.foldCase ? foldCommandWords(words) : words;
}

/** A stdin redirect replaces the pipe; a file or descriptor it names has unknown text. */
function xargsStdin(redirects: RedirectToken[], piped: string | null): string | null {
  const feeds = redirects.some((r) => (r.fd === null || r.fd === "0") && ["<", "<<", "<<-", "<<<", "<&"].includes(r.op));
  return feeds ? stdinScript(redirects) : piped;
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
  if (text !== null) return { texts: hasC ? [text].flat() : [text].flat().flatMap((t) => pipedShellTexts(cmd.name, t)), wrap: hasC ? "sh-c" : "heredoc-shell" };
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
