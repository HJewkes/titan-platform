import type { HookEvent } from "./event.js";
import { config } from "./families/config.js";
import { egress } from "./families/egress.js";
import { choosesHttpConfig } from "./families/http-config.js";
import { merge } from "./families/merge.js";
import { release } from "./families/release.js";
import { secret } from "./families/secret.js";
import { hasDynamicName, namedReadings, wrappedReading } from "./dynamic-readings.js";
import { afterWrites, scriptReadings } from "./line-writes.js";
import { INTERPRETERS } from "./mentions.js";
import { hasOpaqueShebang, isSwappableShebang, MAX_SCRIPT_DEPTH, refuseOpaqueShebang, runsNatively, ScriptDepthError, scriptTargets, SOURCERS } from "./scripts.js";
import type { ScriptTarget } from "./scripts.js";
import { addPathWrite, newPathState, refuseSwappedShells, scriptPathState, takeScriptPath } from "./path-swap.js";
import type { PathState } from "./path-swap.js";
import { resolveValue } from "./shell/path.js";
import { extractCommands } from "./shell/commands.js";
import type { ExtractOptions, SimpleCommand } from "./shell/commands.js";
import { ParseError } from "./shell/lexer.js";
import { ADDED_SCRIPT_WEIGHT, MAX_SCRIPT_BYTES, ReadingLimitError, ScriptBudgetError, UnreadableScriptError } from "./shell/unsure-readings.js";
import type { ScriptOverrun } from "./shell/unsure-readings.js";
import { refuseFdScripts } from "./fd-scripts.js";
import { classified } from "./spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "./types.js";

/** The family registry. A new family adds one line here and its rows to `SPELLINGS`. */
const FAMILIES: readonly Family[] = [secret, config, merge, release, egress];
/** Names a reading of dynamic wrapper words is walked for: those a family reads differently, and those whose script `scriptActions` reads. */
const GUARDED = new Set([...FAMILIES.flatMap((f) => [...(f.names ?? []), ...(f.verbs ?? [])]), ...SOURCERS, ...INTERPRETERS]);

/**
 * What an event would do. Pure: the filesystem is reached only through `ctx`. Throws the
 * shell's `ParseError` for a Bash command it cannot parse and `ReadingLimitError` for one with more
 * dynamic wrapper readings or script text than it checks; the hook owns that failure policy.
 */
export function classify(event: HookEvent, ctx: ClassifyContext): ClassifiedAction[] {
  if (event.kind === "bash") return classifyCommand(event.command, event.cwd, ctx, newMemo());
  if (event.kind === "read") return unique(FAMILIES.flatMap((f) => f.read?.(event, ctx) ?? []));
  if (event.kind === "write") return unique(FAMILIES.flatMap((f) => f.write?.(event, ctx) ?? []));
  return [];
}

/** The scripts one line runs; null inside a script, which follows no script of its own. */
interface ScriptMemo {
  /** Verdicts by the line state they were read in, then by `scriptKey`. */
  verdicts: Map<ClassifyContext, Map<string, ScriptVerdict>>;
  /** What is left of `MAX_SCRIPT_BYTES`; a script the memo already holds costs nothing. */
  bytesLeft: number;
  /** Paths whose first line is a `#!` the guard cannot follow; kept beside the memo because `bash x.sh` and `./x.sh` share a verdict but only the second runs that line. */
  opaque: Set<string>;
  /** How many scripts deep the text being classified is: 0 on the line, 1 in a script it runs, and so on. */
  depth: number;
  /** What the text being classified does to PATH, whole, so a script is judged by a write that runs before it wherever the text puts it. */
  path: PathState;
}

/** A script's actions and what it does to PATH, which depend only on its text and `scriptKey`, never on the caller's PATH. */
interface ScriptVerdict {
  actions: ClassifiedAction[];
  path: PathState;
}

function newMemo(): ScriptMemo {
  return { verdicts: new Map(), bytesLeft: MAX_SCRIPT_BYTES, opaque: new Set(), depth: 0, path: newPathState() };
}

function classifyCommand(src: string, cwd: string | null, ctx: ClassifyContext, scripts: ScriptMemo | null): ClassifiedAction[] {
  // Emission order is not run order (a function or loop body is walked where it is written), so a PATH write anywhere in the text counts for every script in it.
  const onPathWrite = (unsafe: boolean, dirs: string[]): void => {
    if (scripts) addPathWrite(scripts.path, unsafe, dirs);
  };
  const commands = extractCommands(src, { ...extractOptions(cwd, ctx, scripts, false), onPathWrite });
  const line = withHttpConfig(src, commands, ctx);
  const asWritten = classifyLine(commands, line, scripts);
  return ctx.foldCase ? unique([...asWritten, ...foldedActions(src, cwd, line, scripts)]) : asWritten;
}

/** Marks the line when it may choose or write an HTTP client's config file, read from these commands. */
function withHttpConfig(src: string, commands: SimpleCommand[], ctx: ClassifyContext): ClassifyContext {
  return choosesHttpConfig(src, commands, ctx.home, ctx.foldCase === true) ? { ...ctx, httpConfigUnseen: true } : ctx;
}

/**
 * A script's text (`scripts` null) stops at the dynamic-word cap and reads on as main does; the line refuses past it.
 * Only the line, which the Bash tool's own bash or zsh runs, joins a `[[`'s operators.
 */
function extractOptions(cwd: string | null, ctx: ClassifyContext, scripts: ScriptMemo | null, foldCase: boolean): ExtractOptions {
  const inScript = scripts === null || scripts.depth > 0;
  return { cwd, home: ctx.home, foldCase, guarded: GUARDED, stopPastCap: inScript, arithmetic: !inScript, joinsConditional: !inScript };
}

/**
 * Where the filesystem finds a program whatever its case, `GIT` runs git, so the whole line is read again with every
 * command word lower-cased. That reading has its own pipes, groups and head, and only adds actions; the as-written
 * reading, as on a case-sensitive filesystem, still decides alone what an error in the folded one drops,
 * except the reading limit, which a folded command word can reach first.
 */
function foldedActions(src: string, cwd: string | null, ctx: ClassifyContext, scripts: ScriptMemo | null): ClassifiedAction[] {
  try {
    const folded = extractCommands(src, extractOptions(cwd, ctx, scripts, true));
    return classifyLine(folded, withHttpConfig(src, folded, ctx), scripts);
  } catch (error) {
    if (error instanceof ReadingLimitError) throw error;
    return [];
  }
}

function classifyLine(commands: SimpleCommand[], ctx: ClassifyContext, scripts: ScriptMemo | null): ClassifiedAction[] {
  refuseFdScripts(commands);
  const out: ClassifiedAction[] = [];
  let line = ctx;
  for (const cmd of commands) {
    if (cmd.added) {
      out.push(...addedActions(cmd, line, scripts));
      continue;
    }
    out.push(...classifySimple(cmd, line));
    if (scripts) out.push(...scriptActions(cmd, line, scripts));
    line = afterDynamic(cmd, afterAll(cmd, afterWrites(cmd, line)));
  }
  if (scripts) refuseSwappedShells(scripts.path, line);
  return unique(out);
}

/** A command only an added xargs reading runs adds its actions, but an error other than the reading limit drops it, and it never moves the line's state. */
function addedActions(cmd: SimpleCommand, line: ClassifyContext, scripts: ScriptMemo | null): ClassifiedAction[] {
  try {
    return [...classifySimple(cmd, line), ...(scripts ? scriptActions(cmd, line, scripts) : [])];
  } catch (error) {
    if (error instanceof ReadingLimitError) throw error;
    return [];
  }
}

function classifySimple(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  const direct = FAMILIES.flatMap((f) => (f.bash && handles(f, cmd) ? f.bash(cmd, ctx) : []));
  return hasDynamicName(cmd) ? [...direct, ...dynamicActions(cmd, ctx)] : direct;
}

/** Only families that list command names read a dynamic word as one; the others already see it as an unnamed command. */
function dynamicActions(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  const named = FAMILIES.filter((f) => f.names);
  const wrapped = wrappedReading(cmd);
  return [
    ...namedReadings(cmd, named).flatMap((reading) => named.flatMap((f) => (f.bash && handles(f, reading) ? f.bash(reading, ctx) : []))),
    ...(wrapped ? classifySimple(wrapped, ctx) : []),
  ];
}

function afterAll(cmd: SimpleCommand, line: ClassifyContext): ClassifyContext {
  return FAMILIES.reduce((c, f) => f.after?.(cmd, c) ?? c, line);
}

/** A switch read from a dynamic word may never have happened, so it only makes the head unknown and never trusts a new branch. */
function afterDynamic(cmd: SimpleCommand, line: ClassifyContext): ClassifyContext {
  return dynamicReadings(cmd).reduce((l, reading) => {
    const next = afterAll(reading, l);
    return next === l ? l : { ...next, readHead: () => "unknown" };
  }, line);
}

/** The commands a dynamic word could run, so a branch switch behind it moves the head as it does when typed. */
function dynamicReadings(cmd: SimpleCommand): SimpleCommand[] {
  if (!hasDynamicName(cmd)) return [];
  const wrapped = wrappedReading(cmd);
  return [...namedReadings(cmd, FAMILIES.filter((f) => f.names)), ...(wrapped ? [wrapped] : [])];
}

function handles(family: Family, cmd: SimpleCommand): boolean {
  return !family.names || (cmd.name !== null && family.names.has(cmd.name));
}

/**
 * A shell script is classified as a command string, any other script's text gets the mention rule. Inside a script every script it runs is
 * followed, down to `MAX_SCRIPT_DEPTH`; one more refuses the line.
 */
function scriptActions(cmd: SimpleCommand, ctx: ClassifyContext, scripts: ScriptMemo): ClassifiedAction[] {
  const named = scriptTargets(cmd, ctx.home);
  const sources = cmd.name !== null && SOURCERS.has(cmd.name);
  if (sources && named.length === 0) scripts.path.unsafe = true;
  noteLaunchedByPath(cmd, ctx, scripts.path);
  const targets = named.filter((target) => !runsNatively(target, ctx));
  if (scripts.depth >= MAX_SCRIPT_DEPTH && targets.length > 0) throw new ScriptDepthError();
  const ownPath = cmd.pathChanged === true;
  return targets.flatMap((target) => {
    const verdict = memoized(scripts, ctx, scriptKey(cmd, target, ctx, scripts.depth), () => scriptVerdicts(cmd, target, ctx, scripts));
    refuseOpaqueShebang(target, scripts.opaque);
    // Taken here, past the memo, so a verdict replayed for another caller still reaches that caller's PATH.
    takeScriptPath(scripts.path, verdict.path, sources, ownPath);
    if (target.byPath) scripts.path.runs.push({ path: target.path, own: ownPath });
    return verdict.actions.map((a) => (a.action === "secret-read" ? classified("bash.secret.script-by-path", a.subject) : a));
  });
}

/** `parallel` runs the by-path programs it is given, which the walk does not unwrap, so each is judged as a by-path run. */
function noteLaunchedByPath(cmd: SimpleCommand, ctx: ClassifyContext, state: PathState): void {
  if (cmd.name !== "parallel") return;
  for (const word of cmd.args) {
    const path = word.dynamic || !word.value.includes("/") ? null : resolveValue(cmd.dir, word.value, ctx.home);
    if (path === null || !launchesViaEnv(ctx, path)) continue;
    state.viaEnv.add(path);
    state.runs.push({ path, own: cmd.pathChanged === true });
  }
}

function launchesViaEnv(ctx: ClassifyContext, path: string): boolean {
  try {
    return scriptReadings(ctx, path).some(isSwappableShebang);
  } catch {
    return false;
  }
}

/**
 * Text an added reading reads is charged to the line's budget at `ADDED_SCRIPT_WEIGHT` a byte, since main never reads it,
 * an interpreter's as much as a shell script's. A shell script the line runs as written is charged a byte a byte; an
 * interpreter's script it runs as written is not, as main reads that one unbudgeted.
 */
function scriptVerdicts(cmd: SimpleCommand, target: ScriptTarget, ctx: ClassifyContext, budget: ScriptMemo): ScriptVerdict {
  const added = cmd.added === true;
  const path = scriptPathState(budget.path);
  const actions = targetReadings(ctx, target).flatMap((text) => {
    if (hasOpaqueShebang(text)) budget.opaque.add(target.path);
    if (isSwappableShebang(text)) budget.path.viaEnv.add(target.path);
    if (added || target.kind === "shell") charge(budget, { script: target.path.slice(target.path.lastIndexOf("/") + 1), bytes: Buffer.byteLength(text), added });
    return scriptText(cmd, target, text, ctx, { memo: budget, path });
  });
  return { actions, path };
}

/** A shell runs every byte of its script, so one the guard cannot read in full refuses the line; an interpreter's, or a `-c` shell's stdin, is read as far as it reads. */
function targetReadings(ctx: ClassifyContext, target: ScriptTarget): string[] {
  try {
    return scriptReadings(ctx, target.path);
  } catch (error) {
    if ((target.kind === "shell" && !target.relayed) || !(error instanceof UnreadableScriptError)) throw error;
    return error.head === null ? [] : [error.head];
  }
}

function charge(budget: ScriptMemo, script: Omit<ScriptOverrun, "total">): void {
  const cost = script.bytes * (script.added ? ADDED_SCRIPT_WEIGHT : 1);
  if (cost > budget.bytesLeft) throw new ScriptBudgetError({ ...script, total: MAX_SCRIPT_BYTES - budget.bytesLeft + cost });
  budget.bytesLeft -= cost;
}

/**
 * Readings of one command often run the same script (`timeout $P . a.sh` also runs `a.sh` under timeout), and the
 * case-folded reading runs it again; classifying a 64 KiB script each time passes the hook's timeout. A script's
 * verdicts depend only on its text, its directory, the line state and, for an interpreter's, the program that runs it;
 * a state change makes a new context object.
 */
function scriptKey(cmd: SimpleCommand, target: ScriptTarget, ctx: ClassifyContext, depth: number): string {
  const program = target.kind === "interpreter" ? cmd.path : null;
  return JSON.stringify([ctx.foldCase === true, cmd.dir, target.path, program, target.relayed === true, depth]);
}

function memoized(scripts: ScriptMemo, ctx: ClassifyContext, key: string, compute: () => ScriptVerdict): ScriptVerdict {
  const byKey = scripts.verdicts.get(ctx) ?? new Map<string, ScriptVerdict>();
  scripts.verdicts.set(ctx, byKey);
  const hit = byKey.get(key);
  if (hit) return hit;
  const actions = compute();
  byKey.set(key, actions);
  return actions;
}

function scriptText(cmd: SimpleCommand, target: ScriptTarget, text: string, ctx: ClassifyContext, scripts: { memo: ScriptMemo; path: PathState }): ClassifiedAction[] {
  if (target.kind === "shell") {
    try {
      return inside(scripts.memo, scripts.path, () => classifyCommand(text, cmd.dir, ctx, scripts.memo));
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
    }
  }
  const word = { type: "word" as const, value: text, dynamic: false, quoted: true, spliced: false, computed: false, refs: [], subs: [] };
  const name = target.kind === "interpreter" ? cmd.name : null;
  const path = name === null ? null : cmd.path;
  return classifySimple({ name, path, args: [word], env: {}, redirects: [], dir: cmd.dir, wrapping: [], next: null, prev: null, negated: false, chain: { start: null } }, ctx);
}

/** Runs `read` one script deeper, in the script's own PATH state; the memo's byte budget stays shared, so both are restored whatever `read` throws. */
function inside<T>(scripts: ScriptMemo, path: PathState, read: () => T): T {
  const caller = scripts.path;
  scripts.depth++;
  scripts.path = path;
  try {
    return read();
  } finally {
    scripts.depth--;
    scripts.path = caller;
  }
}

function unique(actions: ClassifiedAction[]): ClassifiedAction[] {
  const seen = new Map<string, ClassifiedAction>();
  for (const a of actions) {
    const key = `${a.spelling}\u0000${JSON.stringify(a.subject)}`;
    if (!seen.has(key)) seen.set(key, a);
  }
  return [...seen.values()];
}
