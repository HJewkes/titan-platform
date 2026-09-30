import type { HookEvent } from "./event.js";
import { config } from "./families/config.js";
import { egress } from "./families/egress.js";
import { merge } from "./families/merge.js";
import { release } from "./families/release.js";
import { secret } from "./families/secret.js";
import { scriptTarget } from "./scripts.js";
import type { ScriptTarget } from "./scripts.js";
import { extractCommands } from "./shell/commands.js";
import type { SimpleCommand } from "./shell/commands.js";
import { ParseError } from "./shell/lexer.js";
import { classified } from "./spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "./types.js";

/** The family registry. A new family adds one line here and its rows to `SPELLINGS`. */
const FAMILIES: readonly Family[] = [secret, config, merge, release, egress];

/**
 * What an event would do. Pure: the filesystem is reached only through `ctx`. Throws the
 * shell's `ParseError` for a Bash command it cannot parse; the hook owns that failure policy.
 */
export function classify(event: HookEvent, ctx: ClassifyContext): ClassifiedAction[] {
  if (event.kind === "bash") return classifyCommand(event.command, event.cwd, ctx, true);
  if (event.kind === "read") return unique(FAMILIES.flatMap((f) => f.read?.(event, ctx) ?? []));
  if (event.kind === "write") return unique(FAMILIES.flatMap((f) => f.write?.(event, ctx) ?? []));
  return [];
}

function classifyCommand(src: string, cwd: string | null, ctx: ClassifyContext, followScripts: boolean): ClassifiedAction[] {
  const out: ClassifiedAction[] = [];
  for (const cmd of extractCommands(src, { cwd, home: ctx.home })) {
    out.push(...classifySimple(cmd, ctx));
    if (followScripts) out.push(...scriptActions(cmd, ctx));
  }
  return unique(out);
}

function classifySimple(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  return FAMILIES.flatMap((f) => (f.bash && handles(f, cmd) ? f.bash(cmd, ctx) : []));
}

function handles(family: Family, cmd: SimpleCommand): boolean {
  return !family.names || (cmd.name !== null && family.names.has(cmd.name));
}

/** One level deep: a shell script is classified as a command string, any other script's text gets the mention rule. */
function scriptActions(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  const target = scriptTarget(cmd, ctx.home);
  const text = target && readScript(ctx, target.path);
  if (!target || text === null) return [];
  const actions = scriptText(cmd, target, text, ctx);
  return actions.map((a) => (a.action === "secret-read" ? classified("bash.secret.script-by-path", a.subject) : a));
}

function scriptText(cmd: SimpleCommand, target: ScriptTarget, text: string, ctx: ClassifyContext): ClassifiedAction[] {
  if (target.kind === "shell") {
    try {
      return classifyCommand(text, cmd.dir, ctx, false);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
    }
  }
  const word = { type: "word" as const, value: text, dynamic: false, quoted: true, computed: false, refs: [], subs: [] };
  const name = target.kind === "interpreter" ? cmd.name : null;
  return classifySimple({ name, args: [word], env: {}, redirects: [], dir: cmd.dir }, ctx);
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
