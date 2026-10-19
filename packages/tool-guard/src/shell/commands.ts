import { ParseError } from "./lexer.js";
import { mentionsAlias } from "./alias-mention.js";
import { tokenizeLine } from "./line-tokens.js";
import { changeDir, folded, freshWalk, literalEnv, nestedLists, walkSure } from "./command-env.js";
import { lineBudget } from "./line-budget.js";
import type { OpToken, RedirectToken, Token, WordToken } from "./lexer.js";
import { resolvePath } from "./path.js";
import { xargsStdins } from "./piped-stdin.js";
import { emitReadings, endCommand, forkWalk, type Emission } from "./reading-hand-on.js";
import { findExecs, type Unwrapped } from "./unwrap.js";
import { caseNamed } from "./case-script.js";
import { aliasCommands, type AliasTable } from "./alias-words.js";
import { assign, childVars, expandWord, lookup, noteSureCommands, observeStores, trackCompound, trackVars } from "./vars.js";
import { normalizeDeclarations } from "./declarations.js";
import { AliasDefinitionError, definesAlias } from "./alias-definitions.js";
import { CommandRebindingError, rebindsCommand } from "./command-rebinding.js";
import { prefixHomeUnsafe, prefixOutlives, prefixPath } from "./path-entries.js";
import { isPathName } from "./path-writes.js";
import { cutReading } from "./piped-nul.js";
import { inlineScript, SHELLS } from "./inline-script.js";
import type { Inline } from "./inline-script.js";
import { addRedirect } from "./group-stdin.js";
import { procsubScript, withProcsub, withoutProcsub } from "./procsub-operand.js";
import { descriptorsAfter, emptied, stdinText, TOP_DESCRIPTORS } from "./shell-options.js";
import type { Descriptors } from "./shell-options.js";
import { xargsCommands } from "./xargs-runs.js";
import { runReadings } from "./xargs-readings.js";
import type { Vars } from "./vars.js";
import { newMarks, noteRedirect, recordValue, settle } from "./value-marks.js";
import { noteCommand, noteWord } from "./stored-words.js";
import type { ValueMarks } from "./value-marks.js";
import { ReadingLimitError, unsureReadings } from "./unsure-readings.js";
import type { UnsureBudget } from "./unsure-readings.js";
import { arithmeticSpanEnd, splitsClose } from "./arith-span.js";
import type { Chain, ExtractOptions, SimpleCommand, Wrapping } from "./command-types.js";

export type { Chain, ExtractOptions, SimpleCommand, Wrapping } from "./command-types.js";

const MAX_DEPTH = 8;

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
  /** The command that started this walk had `PATH` or `path` in its own prefix, which every command in the walk runs under. */
  pathPrefix: boolean;
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
    ...freshWalk(null, TOP_DESCRIPTORS),
    out,
    home: options.home ?? null,
    depth: 0,
    foldCase,
    pathPrefix: false,
    aliases: options.aliases ?? null,
    unsure,
    marks: newMarks(),
    onScript: options.onScript ?? null,
    arithmetic: options.arithmetic === true && !splitsClose(src),
  };
  // Only the Bash tool's own line has a known reader, so only it may join a `[[`'s operators.
  walk(tokenizeLine(src, options.joinsConditional === true && !mentionsAlias(src)), observed(w));
  finishMarks(w.marks, options);
  return out;
}

function finishMarks(marks: ValueMarks, options: ExtractOptions): void {
  settle(marks);
  if (marks.homeUnfixed && marks.pathDirs.some((dir) => dir.startsWith("~"))) marks.pathChanged = true;
  if (marks.pathChanged || marks.pathDirs.length > 0) options.onPathWrite?.(marks.pathChanged, marks.pathDirs);
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
    words = withProcsub(words, token);
    redirects = gather(redirects, token, w);
    for (const sub of nestedLists(token)) walk(sub, child(w, [...w.scope.wrapping, "subshell"]));
  }
  noteValues(null, words, w);
  emit(words, redirects, w, null);
  for (const fork of forks) fork();
}

function gather(redirects: RedirectToken[], token: Token, w: Walk): RedirectToken[] {
  if (token.type === "redirect") noteRedirect(w.marks, token);
  return addRedirect(redirects, token);
}

/** An operator ends the command gathered before it in each walk its readings leave; returns the walks of the rest of the list. */
function endAt(list: Token[], at: number, token: OpToken, gathered: { words: WordToken[]; redirects: RedirectToken[] }, w: Walk): Array<() => void> {
  const { words, redirects } = gathered;
  noteValues(token, words, w);
  const { readings, disputed } = emit(words, redirects, w, token.value);
  const walks = [w, ...disputed.map((scope) => forkWalk(w, scope, observeWalk))];
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
  observeWalk(w, w.scope.vars);
  return w;
}

function observeWalk(w: Walk, vars: Vars): void {
  const dirs = (added: string[] | null) => (added === null ? (w.marks.pathChanged = true) : w.marks.pathDirs.push(...added));
  observeStores(vars, (value) => hear(w, value), { dirs, homeUnfixed: () => (w.marks.homeUnfixed = true) });
}

function child(w: Walk, wrapping: Wrapping[], descriptors = w.descriptors): Walk {
  const scope = { dir: w.scope.dir, vars: childVars(w.scope.vars), wrapping };
  return observed({ ...w, scope, ...freshWalk(stdinText(descriptors), descriptors), depth: w.depth + 1 });
}

/** A walk of what a wrapper runs: the wrapper's own `PATH=` prefix is the environment of everything in it. */
function underPrefix(inner: Walk, ownPath: boolean): Walk {
  inner.pathPrefix ||= ownPath;
  return inner;
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
  const pattern = rawWords.length === 1 && rawWords[0]?.casePattern === true;
  for (const cmd of [...runs, ...(cut ? caseNamed(cut) : []), ...aliased.runs]) run(cmd, redirects, w, next, pattern);
  for (const { tokens, aliases } of aliased.scripts) walk(tokens, Object.assign(child(w, [...w.scope.wrapping, "eval"]), { aliases }));
  for (const reading of unsureReadings(runs[0], w.unsure)) walkAdded(reading, redirects, w, next);
  w.walked = null;
  return runs[0] ?? null;
}

function walkAdded(runs: Unwrapped[], redirects: RedirectToken[], w: Walk, next: string | null): void {
  addedReading(w, (copy) => runs.forEach((reading) => run(reading, redirects, copy, next)));
}

function run(raw: Unwrapped, redirects: RedirectToken[], w: Walk, next: string | null, pattern = false): void {
  if (rebindsCommand(raw)) throw new CommandRebindingError();
  if (!pattern && definesAlias(raw)) throw new AliasDefinitionError();
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
  const { name, path, args } = withoutProcsub(cmd);
  w.negated ||= cmd.negated === true;
  const links = { next, prev: w.prev, negated: w.negated, chain: w.chain };
  const inherited = w.prev === "|" || w.prev === "|&" ? emptied(w.descriptors, 0) : w.descriptors;
  const set = inherited === TOP_DESCRIPTORS ? {} : { inherited };
  const own = prefixPath(cmd.assigned, isPathName, w.scope.vars);
  const ownPath = own.unsafe;
  w.marks.pathDirs.push(...own.dirs);
  // Emission order is not run order, so a prefix that may reach later commands changes the whole line's PATH, as a store does.
  if (prefixOutlives(name) && (ownPath || prefixHomeUnsafe(cmd.assigned))) w.marks.pathChanged = true;
  const pathSet = w.marks.pathChanged || w.pathPrefix || ownPath ? { pathChanged: true as const } : {};
  w.out.push({ name, path, args, env: literalEnv(cmd), redirects, dir: w.scope.dir, wrapping, ...links, ...set, ...pathSet });
  const piped = stdin === null ? [] : [stdin, ...(stdin === w.stdin ? w.shellStdin : [])];
  const held = descriptorsAfter(redirects, piped, inherited, (target) => resolvePath(w.scope.dir, target, w.home));
  const script = procsubScript(cmd, (plain) => inlineScript(plain, redirects, piped, w.unsure, inherited)) ?? inlineScript(cmd, redirects, piped, w.unsure, inherited);
  if (script !== null) walkScript(script, w, wrapping, held, ownPath);
  if (cmd.name !== "find") return;
  for (const exec of findExecs(cmd.args).flatMap((words) => caseNamed(folded(words, w)))) run(exec, [], underPrefix(child(w, [...wrapping, "find-exec"], held), ownPath), null);
}

/** Two readings of one command often run the same script (`flock $F sh -c '...'`); walking it again per nesting level would double the cost. */
function walkScript(script: Inline, w: Walk, wrapping: Wrapping[], held: Descriptors, ownPath: boolean): void {
  // A shell reading its script from a descriptor leaves the rest of that stream to it, which is the text walked here.
  const descriptors = script.fd === undefined ? held : emptied(held, script.fd);
  for (const text of script.texts) {
    if (w.walked?.has(text)) continue;
    w.walked?.add(text);
    w.onScript?.(text);
    // A shell's arguments and input become its positional parameters and what its `read` stores.
    if (script.wrap !== "eval") w.marks.opaque = true;
    // A nested shell's text keeps the nested-subshell reading and never joins a `[[`: which shell reads it is not known (it may be dash, or the runner's name may be rebound).
    walk(tokenizeLine(text, false), { ...underPrefix(child(w, [...wrapping, script.wrap], descriptors), ownPath), arithmetic: false });
  }
}
