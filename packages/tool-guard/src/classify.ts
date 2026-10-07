import type { HookEvent } from "./event.js";
import { config } from "./families/config.js";
import { egress } from "./families/egress.js";
import { merge } from "./families/merge.js";
import { release } from "./families/release.js";
import { secret } from "./families/secret.js";
import { hasDynamicName, namedReadings, wrappedReading } from "./dynamic-readings.js";
import { INTERPRETERS } from "./mentions.js";
import { scriptTarget, SOURCERS } from "./scripts.js";
import type { ScriptTarget } from "./scripts.js";
import { extractCommands } from "./shell/commands.js";
import type { SimpleCommand } from "./shell/commands.js";
import { ParseError } from "./shell/lexer.js";
import { ReadingLimitError } from "./shell/unsure-readings.js";
import { classified } from "./spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "./types.js";

/** The family registry. A new family adds one line here and its rows to `SPELLINGS`. */
const FAMILIES: readonly Family[] = [secret, config, merge, release, egress];
/** Names a reading of dynamic wrapper words is walked for: those a family reads differently, and those whose script `scriptActions` reads. */
const GUARDED = new Set([...FAMILIES.flatMap((f) => [...(f.names ?? []), ...(f.verbs ?? [])]), ...SOURCERS, ...INTERPRETERS]);

/**
 * What an event would do. Pure: the filesystem is reached only through `ctx`. Throws the
 * shell's `ParseError` for a Bash command it cannot parse and `ReadingLimitError` for one with more
 * dynamic wrapper readings than it checks; the hook owns that failure policy.
 */
export function classify(event: HookEvent, ctx: ClassifyContext): ClassifiedAction[] {
  if (event.kind === "bash") return classifyCommand(event.command, event.cwd, ctx, new Map());
  if (event.kind === "read") return unique(FAMILIES.flatMap((f) => f.read?.(event, ctx) ?? []));
  if (event.kind === "write") return unique(FAMILIES.flatMap((f) => f.write?.(event, ctx) ?? []));
  return [];
}

/**
 * The verdicts of the shell scripts one line runs, by the line state they were read in, then by `scriptKey`. Null inside
 * a script, which follows no script of its own.
 */
type ScriptMemo = Map<ClassifyContext, Map<string, ClassifiedAction[]>>;

function classifyCommand(src: string, cwd: string | null, ctx: ClassifyContext, scripts: ScriptMemo | null): ClassifiedAction[] {
  const asWritten = classifyLine(extractCommands(src, { cwd, home: ctx.home, guarded: GUARDED }), ctx, scripts);
  return ctx.foldCase ? unique([...asWritten, ...foldedActions(src, cwd, ctx, scripts)]) : asWritten;
}

/**
 * Where the filesystem finds a program whatever its case, `GIT` runs git, so the whole line is read again with every
 * command word lower-cased. That reading has its own pipes, groups and head, and only adds actions; the as-written
 * reading, as on a case-sensitive filesystem, still decides alone what an error in the folded one drops,
 * except the reading limit, which a folded command word can reach first.
 */
function foldedActions(src: string, cwd: string | null, ctx: ClassifyContext, scripts: ScriptMemo | null): ClassifiedAction[] {
  try {
    return classifyLine(extractCommands(src, { cwd, home: ctx.home, foldCase: true, guarded: GUARDED }), ctx, scripts);
  } catch (error) {
    if (error instanceof ReadingLimitError) throw error;
    return [];
  }
}

function classifyLine(commands: SimpleCommand[], ctx: ClassifyContext, scripts: ScriptMemo | null): ClassifiedAction[] {
  const out: ClassifiedAction[] = [];
  let line = ctx;
  for (const cmd of commands) {
    if (cmd.added) {
      out.push(...addedActions(cmd, line, scripts));
      continue;
    }
    out.push(...classifySimple(cmd, line));
    if (scripts) out.push(...scriptActions(cmd, line, scripts));
    line = afterDynamic(cmd, afterAll(cmd, line));
  }
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

/** One level deep: a shell script is classified as a command string, any other script's text gets the mention rule. */
function scriptActions(cmd: SimpleCommand, ctx: ClassifyContext, scripts: ScriptMemo): ClassifiedAction[] {
  const target = scriptTarget(cmd, ctx.home);
  if (!target) return [];
  const actions = target.kind === "shell" ? memoized(scripts, ctx, scriptKey(cmd, target, ctx), () => scriptVerdicts(cmd, target, ctx)) : scriptVerdicts(cmd, target, ctx);
  return actions.map((a) => (a.action === "secret-read" ? classified("bash.secret.script-by-path", a.subject) : a));
}

function scriptVerdicts(cmd: SimpleCommand, target: ScriptTarget, ctx: ClassifyContext): ClassifiedAction[] {
  const text = readScript(ctx, target.path);
  return text === null ? [] : scriptText(cmd, target, text, ctx);
}

/**
 * Readings of one command often run the same script (`timeout $P . a.sh` also runs `a.sh` under timeout), and the
 * case-folded reading runs it again; classifying a 64 KiB script each time passes the hook's timeout. A shell script's
 * verdicts depend only on its text, its directory and the line state, and a state change makes a new context object.
 */
function scriptKey(cmd: SimpleCommand, target: ScriptTarget, ctx: ClassifyContext): string {
  return JSON.stringify([ctx.foldCase === true, cmd.dir, target.path]);
}

function memoized(scripts: ScriptMemo, ctx: ClassifyContext, key: string, compute: () => ClassifiedAction[]): ClassifiedAction[] {
  const byKey = scripts.get(ctx) ?? new Map<string, ClassifiedAction[]>();
  scripts.set(ctx, byKey);
  const hit = byKey.get(key);
  if (hit) return hit;
  const actions = compute();
  byKey.set(key, actions);
  return actions;
}

function scriptText(cmd: SimpleCommand, target: ScriptTarget, text: string, ctx: ClassifyContext): ClassifiedAction[] {
  if (target.kind === "shell") {
    try {
      return classifyCommand(text, cmd.dir, ctx, null);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
    }
  }
  const word = { type: "word" as const, value: text, dynamic: false, quoted: true, spliced: false, computed: false, refs: [], subs: [] };
  const name = target.kind === "interpreter" ? cmd.name : null;
  const path = name === null ? null : cmd.path;
  return classifySimple({ name, path, args: [word], env: {}, redirects: [], dir: cmd.dir, wrapping: [], next: null, prev: null, negated: false, chain: { start: null } }, ctx);
}

function readScript(ctx: ClassifyContext, path: string): string | null {
  try {
    return ctx.readScript(path);
  } catch {
    return null;
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
