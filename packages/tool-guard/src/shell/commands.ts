import { ParseError, SplitParseError, tokenize } from "./lexer.js";
import { NestingLimitError } from "./nesting.js";
import type { OpToken, RedirectToken, Token, WordToken } from "./lexer.js";
import { resolvePath } from "./path.js";
import { xargsStdins } from "./piped-stdin.js";
import { emitReadings, endCommand, forkWalk, type Emission } from "./reading-hand-on.js";
import { findExecs, type Unwrapped } from "./unwrap.js";
import { caseNamed } from "./case-script.js";
import { foldCommandWords } from "./case-literal.js";
import { aliasCommands, type AliasTable } from "./alias-words.js";
import { assign, childVars, expandWord, lookup, noteSureCommands, observeStores, trackCompound, trackVars } from "./vars.js";
import { normalizeDeclarations } from "./declarations.js";
import { CommandRebindingError, rebindsCommand } from "./command-rebinding.js";
import { cutReading } from "./piped-nul.js";
import { inlineScript, SHELLS } from "./inline-script.js";
import type { Inline } from "./inline-script.js";
import { addRedirect } from "./group-stdin.js";
import { descriptorsAfter, emptied, stdinText, TOP_DESCRIPTORS } from "./shell-options.js";
import type { Descriptors } from "./shell-options.js";
import { xargsCommands } from "./xargs-runs.js";
import { runReadings } from "./xargs-readings.js";
import type { Vars } from "./vars.js";
import { newMarks, noteRedirect, recordValue, settle } from "./value-marks.js";
import { noteCommand, noteWord } from "./stored-words.js";
import type { ValueMarks } from "./value-marks.js";
import { MAX_UNSURE_WORDS, NestingReadingError, ReadingLimitError, SPLICED_WEIGHT, SplitReadingError, unsureReadings, ValueWalkError } from "./unsure-readings.js";
import type { UnsureBudget } from "./unsure-readings.js";
import { arithmeticSpanEnd, splitsClose } from "./arith-span.js";

const MAX_DEPTH = 8;
const RUNNERS = new Set([...SHELLS, "eval", "emulate", "find"]);

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
  /** What its descriptors held before its own redirects, when a command that runs it set them up (`bash -c bash < f`). */
  inherited?: Descriptors;
}

export interface ExtractOptions {
  cwd?: string | null;
  /** Expands `~`, `$HOME` and a bare `cd`; null leaves them unknown. */
  home?: string | null;
  /** Reads every command word lower-cased, as a filesystem that finds `GIT` as git runs it; arguments stay as written. */
  foldCase?: boolean;
  /**
   * Command names classify reads other than by their arguments' default treatment: guarded programs, the names a
   * family adds a verdict for or exempts, interpreters and `source`. A reading of dynamic wrapper words is skipped only
   * when neither its name nor the command's as written is one. Omitted: every name.
   */
  guarded?: ReadonlySet<string>;
  /**
   * Past the budget of dynamic wrapper readings, read the rest as if it had none, as main does, instead of throwing
   * `ReadingLimitError`. For a script the line runs, which the user cannot split further.
   */
  stopPastCap?: boolean;
  aliases?: AliasTable;
  /** Called with each script text the walk reads (a `-c` string, eval text, a heredoc or piped script), before reading it. */
  onScript?: (text: string) => void;
  /** The text is the Bash tool's own line, run by bash or zsh, where `((x))` may be arithmetic; off, it reads as nested subshells that run `x`. */
  arithmetic?: boolean;
}

interface Scope {
  dir: string | null;
  vars: Vars;
  wrapping: Wrapping[];
}

interface Walk {
  scope: Scope;
  stack: Scope[];
  out: SimpleCommand[];
  home: string | null;
  depth: number;
  /** Literal text piped into the command being emitted, as `echo 'git push' | bash` does. */
  stdin: string | null;
  /** bash's and zsh's texts of a print piped straight in, where they differ from `stdin` (`printf 'echo \c; …' | bash`). */
  shellStdin: string[];
  /** What the shell running this walk's commands holds on each descriptor before their own redirects. */
  descriptors: Descriptors;
  /** The operator before the command being emitted. */
  prev: string | null;
  chain: Chain;
  /** Whether `!` negates the pipeline the command being emitted belongs to. */
  negated: boolean;
  foldCase: boolean;
  /** Script texts the readings of the command being emitted have walked, so a later reading walks each text once; null outside one. */
  walked: Set<string> | null;
  aliases: AliasTable | null;
  /** The line's budget of `unsure` reading words, shared by every walk of it. */
  unsure: UnsureBudget;
  /** What the line stores and whether it evaluates arithmetic, shared by every walk of it. */
  marks: ValueMarks;
  onScript: ((text: string) => void) | null;
  /** Whether this walk's `((` may read as arithmetic: only the line itself and its substitutions, never a nested shell's text. */
  arithmetic: boolean;
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
  const unsure = lineBudget(src, options);
  const w: Walk = {
    scope,
    stack: [],
    out,
    home: options.home ?? null,
    depth: 0,
    stdin: null,
    shellStdin: [],
    descriptors: TOP_DESCRIPTORS,
    prev: null,
    chain: { start: null },
    negated: false,
    foldCase,
    walked: null,
    aliases: options.aliases ?? null,
    unsure,
    marks: newMarks(),
    onScript: options.onScript ?? null,
    arithmetic: options.arithmetic === true && !splitsClose(src),
  };
  walk(tokenizeLine(src), observed(w));
  settle(w.marks);
  return out;
}

/** The line's budget of `unsure` reading words and spliced text, shared by every walk of it. */
function lineBudget(src: string, options: ExtractOptions): UnsureBudget {
  return {
    left: MAX_UNSURE_WORDS,
    splicedLeft: SPLICED_WEIGHT * src.length,
    decides: decider(options.guarded),
    stopPastCap: options.stopPastCap === true,
  };
}

/** A line bash 5 and bash 3.2 read differently is refused outright, whatever it names; a plain ParseError is not. */
function tokenizeLine(src: string): Token[] {
  try {
    return tokenize(src);
  } catch (error) {
    if (error instanceof SplitParseError) throw new SplitReadingError(error.split);
    if (error instanceof NestingLimitError) throw new NestingReadingError();
    throw error;
  }
}

function walk(tokens: Token[], w: Walk): void {
  if (w.depth > MAX_DEPTH) throw new ParseError("nesting too deep");
  walkFrom(noteSureCommands(normalizeDeclarations(tokens)), 0, w);
}

/** A command whose `{name}` readings leave different scopes has the rest of its list walked again in each, after this walk. */
function walkFrom(list: Token[], start: number, w: Walk): void {
  const forks: Array<() => void> = [];
  let words: WordToken[] = [];
  let redirects: RedirectToken[] = [];
  let arithEnd = -1;
  for (const [offset, token] of list.slice(start).entries()) {
    const at = start + offset;
    if (at <= arithEnd) {
      inArithmetic(token, at === arithEnd, w);
      continue;
    }
    const end = arithmeticEnd(list, at, words, w);
    if (end > 0) {
      arithEnd = end;
      continue;
    }
    if (token.type === "op") {
      forks.push(...endAt(list, at, token, { words, redirects }, w));
      words = [];
      redirects = [];
      continue;
    }
    if (token.type === "word") words.push(noteWord(token, w.marks));
    if (token.type === "redirect") noteRedirect(w.marks, token);
    redirects = addRedirect(redirects, token);
    for (const sub of nestedLists(token)) walk(sub, child(w, [...w.scope.wrapping, "subshell"]));
  }
  noteValues(null, words, w);
  emit(words, redirects, w, null);
  for (const fork of forks) fork();
}

/** An operator ends the command gathered before it in each walk its readings leave; returns the walks of the rest of the list. */
function endAt(list: Token[], at: number, token: OpToken, gathered: { words: WordToken[]; redirects: RedirectToken[] }, w: Walk): Array<() => void> {
  const { words, redirects } = gathered;
  noteValues(token, words, w);
  const { readings, disputed } = emit(words, redirects, w, token.value);
  const walks = [w, ...disputed.map((scope) => forkWalk(w, scope, (fork, vars) => observeStores(vars, (value) => hear(fork, value))))];
  for (const each of walks) endCommand(each, token, words, redirects, readings, (op) => scope(op, each));
  return walks.slice(1).map((fork) => () => walkFrom(list, at + 1, fork));
}

/**
 * The index of the `)` that ends the arithmetic command a marked `(` opens, or -1 when the token opens none. It
 * still notes what the command evaluates and writes, in the current shell.
 */
function arithmeticEnd(list: Token[], at: number, words: WordToken[], w: Walk): number {
  const token = list[at];
  const end = arithmeticSpanEnd(list, at, words, w.arithmetic);
  if (end < 0 || token?.type !== "op") return -1;
  noteValues(token, words, w);
  noteValues(null, list.slice(at + 2, end - 1).filter((t) => t.type === "word"), w);
  trackCompound(token, w.scope.vars);
  return end;
}

/** A token of an arithmetic command runs nothing, but a substitution in it does; its `)` leaves the shell as it was. */
function inArithmetic(token: Token, last: boolean, w: Walk): void {
  if (token.type === "word") noteWord(token, w.marks);
  for (const sub of nestedLists(token)) walk(sub, child(w, [...w.scope.wrapping, "subshell"]));
  if (!last) return;
  Object.assign(w, { prev: ")", negated: false, chain: { start: ")" }, stdin: null, shellStdin: [] });
  trackCompound(token, w.scope.vars);
}

/** Notes what a command evaluates and stores, before it runs. */
function noteValues(op: Token | null, words: WordToken[], w: Walk): void {
  noteCommand(w.marks, { op, words, prev: w.prev }, (value) => hear(w, value));
}

/** Records a stored value; a known one is walked, if the line evaluates arithmetic, in the scope it was stored in. */
function hear(w: Walk, value: string | null): void {
  recordValue(w.marks, value, (list) => {
    const into = child(w, [...w.scope.wrapping, "subshell"]);
    return () => walkSure(() => walk(list, into));
  });
}

/** A walk whose variables report every value they store. */
function observed(w: Walk): Walk {
  observeStores(w.scope.vars, (value) => hear(w, value));
  return w;
}

/** A substitution the lexer rejects while it is walked leaves the line unchecked, which the hook refuses. */
function walkSure(walkText: () => void): void {
  try {
    walkText();
  } catch (error) {
    throw error instanceof ParseError ? new ValueWalkError() : error;
  }
}

function nestedLists(token: Token): Token[][] {
  if (token.type === "redirect") return [...(token.target?.subs ?? []), ...token.subs];
  return token.type === "op" ? [] : token.subs;
}

function child(w: Walk, wrapping: Wrapping[], descriptors = w.descriptors): Walk {
  const scope = { dir: w.scope.dir, vars: childVars(w.scope.vars), wrapping };
  const fresh = { stack: [], depth: w.depth + 1, stdin: stdinText(descriptors), shellStdin: [], descriptors, prev: null, chain: { start: null }, negated: false, walked: null };
  return observed({ ...w, scope, ...fresh });
}

function scope(op: string, w: Walk): void {
  if (op === "(") {
    w.stack.push(w.scope);
    w.scope = { dir: w.scope.dir, vars: new Map(w.scope.vars), wrapping: [...w.scope.wrapping, "subshell"] };
    observed(w);
  }
  if (op === ")") w.scope = w.stack.pop() ?? w.scope;
}

function emit(rawWords: WordToken[], rawRedirects: RedirectToken[], w: Walk, next: string | null): Emission<Scope> {
  return emitReadings(rawWords, rawRedirects, w, besideWalk, (words, redirects, on) => emitReading(words, redirects, on, next));
}

function emitReading(rawWords: WordToken[], rawRedirects: RedirectToken[], w: Walk, next: string | null): Unwrapped | null {
  const expand = (word: WordToken) => expandWord(word, (name) => lookup(w.scope.vars, w.home, name));
  const redirects = rawRedirects.map((r) => (r.target ? { ...r, target: expand(r.target) } : r));
  const words = folded(rawWords.map(expand), w);
  const runs = caseNamed(words);
  const cut = cutReading(words);
  const aliased = aliasCommands(words, w.aliases);
  w.walked = new Set();
  for (const cmd of [...runs, ...(cut ? caseNamed(cut) : []), ...aliased.runs]) run(cmd, redirects, w, next);
  for (const { tokens, aliases } of aliased.scripts) walk(tokens, Object.assign(child(w, [...w.scope.wrapping, "eval"]), { aliases }));
  for (const reading of unsureReadings(runs[0], w.unsure)) walkAdded(reading, redirects, w, next);
  w.walked = null;
  return runs[0] ?? null;
}

function walkAdded(runs: Unwrapped[], redirects: RedirectToken[], w: Walk, next: string | null): void {
  addedReading(w, (copy) => runs.forEach((reading) => run(reading, redirects, copy, next)));
}

/** A dynamic or guarded command word, or one that runs more commands: shell text, a `.sh` script, `xargs` or `find -exec`. */
function decider(guarded: ReadonlySet<string> | undefined): (cmd: Unwrapped) => boolean {
  return (cmd) => cmd.name === null || cmd.xargs !== undefined || cmd.script !== undefined || RUNNERS.has(cmd.name) || cmd.name.endsWith(".sh") || (guarded?.has(cmd.name) ?? true);
}

function run(raw: Unwrapped, redirects: RedirectToken[], w: Walk, next: string | null): void {
  if (rebindsCommand(raw)) throw new CommandRebindingError();
  if (raw.name === null && raw.args.length === 0 && !raw.xargs?.words.length) {
    for (const assignment of raw.assigned) assign(w.scope.vars, assignment);
    if (redirects.length === 0) return;
  }
  if (raw.name === "cd" || raw.name === "pushd") {
    w.scope.dir = changeDir(w.scope.dir, raw.args.find((a) => a.value === "-" || !a.value.startsWith("-")), w.home);
    return;
  }
  for (const stdin of raw.xargs ? xargsStdins(redirects, w.stdin, w.shellStdin) : [w.stdin]) {
    const runs = runReadings(stdin, (name) => name !== null && SHELLS.has(name));
    for (const cmd of xargsCommands(raw, stdin, runs.main)) runOnce(cmd, redirects, w, next, stdin);
    if (raw.xargs) for (const cmd of xargsCommands(raw, stdin, runs.added)) runAdded(cmd, redirects, w, next, stdin);
  }
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
    read(besideWalk(w));
  } catch (error) {
    // Main's runs of the same command still decide; this reading is dropped, unless the line is past checking.
    if (error instanceof ReadingLimitError) throw error;
  } finally {
    for (let i = start; i < w.out.length; i++) w.out[i] = { ...(w.out[i] as SimpleCommand), added: true };
  }
}

/** A walk on a copy of the scope, so a `cd` or an assignment in a reading on it moves nothing; its commands decide as main's do. */
function besideWalk(w: Walk): Walk {
  return observed({ ...w, scope: { ...w.scope, vars: new Map(w.scope.vars) } });
}

function runOnce(cmd: Unwrapped, redirects: RedirectToken[], w: Walk, next: string | null, stdin: string | null): void {
  trackVars(cmd, w.scope.vars);
  // A prefix assignment stores its value only for the command, which the variables do not hold; an element is heard where typed.
  if (cmd.name !== null || cmd.args.length > 0) for (const [, value, kind] of cmd.assigned) if (kind !== "hidden" && kind !== "element") hear(w, value);
  const wrapping: Wrapping[] = cmd.xargs ? [...w.scope.wrapping, "xargs"] : w.scope.wrapping;
  const { name, path, args } = cmd;
  w.negated ||= cmd.negated === true;
  const links = { next, prev: w.prev, negated: w.negated, chain: w.chain };
  const inherited = w.prev === "|" || w.prev === "|&" ? emptied(w.descriptors, 0) : w.descriptors;
  const set = inherited === TOP_DESCRIPTORS ? {} : { inherited };
  w.out.push({ name, path, args, env: literalEnv(cmd), redirects, dir: w.scope.dir, wrapping, ...links, ...set });
  const piped = stdin === null ? [] : [stdin, ...(stdin === w.stdin ? w.shellStdin : [])];
  const held = descriptorsAfter(redirects, piped, inherited, (target) => resolvePath(w.scope.dir, target, w.home));
  const script = inlineScript(cmd, redirects, piped, w.unsure, inherited);
  if (script !== null) walkScript(script, w, wrapping, held);
  if (cmd.name !== "find") return;
  for (const exec of findExecs(cmd.args).flatMap((words) => caseNamed(folded(words, w)))) run(exec, [], child(w, [...wrapping, "find-exec"], held), null);
}

/** Two readings of one command often run the same script (`flock $F sh -c '...'`); walking it again per nesting level would double the cost. */
function walkScript(script: Inline, w: Walk, wrapping: Wrapping[], held: Descriptors): void {
  // A shell reading its script from a descriptor leaves the rest of that stream to it, which is the text walked here.
  const descriptors = script.fd === undefined ? held : emptied(held, script.fd);
  for (const text of script.texts) {
    if (w.walked?.has(text)) continue;
    w.walked?.add(text);
    w.onScript?.(text);
    // A shell's arguments and input become its positional parameters and what its `read` stores.
    if (script.wrap !== "eval") w.marks.opaque = true;
    // A nested shell's text keeps the nested-subshell reading: the shell that runs it may be dash.
    walk(tokenizeLine(text), { ...child(w, [...wrapping, script.wrap], descriptors), arithmetic: false });
  }
}

function folded(words: WordToken[], w: Walk): WordToken[] {
  return w.foldCase ? foldCommandWords(words) : words;
}

function literalEnv(cmd: Unwrapped): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value, kind] of cmd.assigned) if (value !== null && !kind) env[name] = value;
  return env;
}

function changeDir(dir: string | null, word: WordToken | undefined, home: string | null): string | null {
  if (!word) return home;
  return word.value === "-" ? null : resolvePath(dir, word, home);
}
