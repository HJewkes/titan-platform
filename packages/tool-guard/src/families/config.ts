import { BYPASS_VAR } from "../actor.js";
import type { WriteEvent } from "../event.js";
import { commandMentions, pathMentions } from "../mentions.js";
import type { Mention } from "../mentions.js";
import { GUARDED_PATHS } from "../paths.js";
import type { SimpleCommand } from "../shell/commands.js";
import type { WordToken } from "../shell/lexer.js";
import { parseGit } from "../shell/git.js";
import { basename } from "../shell/path.js";
import { classified } from "../spellings.js";
import type { SpellingId } from "../spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "../types.js";
import { copyDestination } from "./copy-destination.js";

/** Config reads are allowed by the table; only edits are CFG. */
const READ_ONLY = new Set(["cat", "head", "tail", "less", "grep", "rg", "jq", "ls", "stat", "diff", "wc", "test", "[", "[["]);
const REMOVERS = new Set(["rm", "unlink", "truncate", "chmod"]);
const IN_PLACE = new Set(["sed", "gsed", "perl"]);
/** Copiers whose sources are only read; `mv` also removes its sources, so every mention counts. */
const COPIERS = new Set(["cp", "install", "ln", "mv"]);
const CLAUDE_CLI: Record<string, Set<string>> = {
  config: new Set(["set", "add", "remove"]),
  mcp: new Set(["add", "add-json", "remove"]),
  plugin: new Set(["install", "uninstall"]),
};
/** Builtins that set a variable the shell passes to its children. */
const DECLARERS = new Set(["export", "declare", "typeset", "local", "readonly"]);
const STORERS = new Set(["printf", "read", "mapfile", "readarray", "let"]);
const GIT_CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "-l", "--list"]);

function bash(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction[] {
  const special = namedWrite(cmd, ctx);
  const mentions = [...commandMentions(cmd, ctx, GUARDED_PATHS.config), ...copyIntoMentions(cmd, ctx)];
  const actions = mentions.flatMap((m) => {
    const spelling = spellingOf(cmd, m);
    return spelling ? [classified(spelling, { pattern: m.id })] : [];
  });
  return special ? [special, ...actions] : actions;
}

function spellingOf(cmd: SimpleCommand, m: Mention): SpellingId | null {
  const spelling = writeSpelling(cmd, m);
  return spelling && m.id === "any:.git/hooks" ? "bash.config.git-hooks" : spelling;
}

function writeSpelling(cmd: SimpleCommand, m: Mention): SpellingId | null {
  if (m.site === "redirect-in") return null;
  if (m.site === "redirect-out") return "bash.config.redirect-out";
  const name = cmd.name;
  if (name !== null && IN_PLACE.has(name)) return inPlaceSpelling(cmd, name);
  if (m.site === "inline") return "bash.config.interpreter";
  if (name === null) return "bash.config.mention";
  if (READ_ONLY.has(name)) return null;
  if (name === "tee") return "bash.config.tee";
  if (COPIERS.has(name)) return writesTo(cmd, m) ? "bash.config.cp-mv-ln" : null;
  return REMOVERS.has(name) ? "bash.config.remove" : "bash.config.mention";
}

/** `sed` without `-i` only reads; `perl` without `-i` is still an interpreter. */
function inPlaceSpelling(cmd: SimpleCommand, name: string): SpellingId | null {
  if (cmd.args.some((a) => /^-[a-zA-Z]*i/.test(a.value) || a.value.startsWith("--in-place"))) return "bash.config.in-place";
  return name === "perl" ? "bash.config.interpreter" : null;
}

function writesTo(cmd: SimpleCommand, m: Mention): boolean {
  return cmd.name === "mv" || m.word === null || m.word === copyDestination(cmd);
}

/** `cp /tmp/settings.json ~/.claude/` writes `~/.claude/settings.json`: the destination joined with each source's name. */
function copyIntoMentions(cmd: SimpleCommand, ctx: ClassifyContext): Mention[] {
  const dest = copyDestination(cmd);
  if (!dest) return [];
  const into = dest.value.replace(/^--target-directory=/, "").replace(/\/+$/, "");
  const sources = cmd.args.filter((a) => a !== dest && !a.value.startsWith("-"));
  const joined = sources.map((s) => ({ ...s, value: `${into}/${basename(s.value)}` }));
  const copied = { ...cmd, args: joined, env: {}, redirects: [] };
  return commandMentions(copied, ctx, GUARDED_PATHS.config).map((m) => ({ ...m, word: null }));
}

/** The variable a word names when it assigns, before any `=` or `[`; `=1` with nothing before it is a substitution that dropped. */
function assignedName(word: WordToken): string {
  return word.value.split(/[=[]/, 1)[0] ?? "";
}

/** A name the reader cannot spell out: it holds an expansion, or a substitution dropped from the word. */
function unreadableName(word: WordToken): boolean {
  const name = assignedName(word);
  return /[$`]/.test(name) || (name === "" && word.subs.length > 0);
}

const operands = (cmd: SimpleCommand) => cmd.args.filter((a) => !a.value.startsWith("-"));

/** A nameref makes the next `export r=1` set whatever `r` points at, so a `-n` declaration may not point at anything unread; a literal bypass name is denied wherever it appears. */
function pointsAtBypass(cmd: SimpleCommand): boolean {
  if (!cmd.args.some((a) => /^-[a-zA-Z]*n/.test(a.value))) return false;
  return operands(cmd).some((a) => a.value.includes("=") && a.dynamic);
}

/** `export X=1` stores no prefix assignment, so a declaration builtin's arguments are read for the name. */
function declaresBypass(cmd: SimpleCommand): boolean {
  return operands(cmd).some((a) => unreadableName(a)) || pointsAtBypass(cmd);
}

/** Under `set -a` any of these stores into the environment; they are denied by name wherever they appear. */
function storesBypass(cmd: SimpleCommand): boolean {
  const targets = cmd.name === "printf" ? cmd.args.slice(cmd.args.findIndex((a) => a.value === "-v") + 1).slice(0, 1) : operands(cmd);
  const named = cmd.name === "printf" && !cmd.args.some((a) => a.value === "-v") ? [] : targets;
  return cmd.name !== "let" && named.some(unreadableName);
}

/** `env $N=1 claude` reads as a command with no name, so an assignment-shaped word whose name is unread is checked there too. */
function envsBypass(cmd: SimpleCommand): boolean {
  return cmd.args.some((a) => a.value.includes("=") && (unreadableName(a)));
}

function setsBypass(cmd: SimpleCommand): boolean {
  if (cmd.name === null || cmd.name === "env") return envsBypass(cmd);
  if (DECLARERS.has(cmd.name)) return declaresBypass(cmd);
  return STORERS.has(cmd.name) && storesBypass(cmd);
}

function namedWrite(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction | null {
  if (setsBypass(cmd)) return classified("bash.config.bypass-env", { pattern: `env:${BYPASS_VAR}` });
  if (cmd.name === "git" && setsHooksPath(cmd, ctx)) {
    return classified("bash.config.git-config-hookspath", { pattern: "git:core.hooksPath" });
  }
  if (cmd.name !== "claude") return null;
  const [group, verb] = cmd.args.map((a) => a.value);
  const verbs = group !== undefined && Object.hasOwn(CLAUDE_CLI, group) ? CLAUDE_CLI[group] : undefined;
  if (!verbs || verb === undefined || !verbs.has(verb)) return null;
  return classified("bash.config.claude-cli", { pattern: `claude:${group}` });
}

function setsHooksPath(cmd: SimpleCommand, ctx: ClassifyContext): boolean {
  const git = parseGit(cmd.args, cmd.dir, ctx.home);
  if (git.sub !== "config") return false;
  const values = git.subArgs.map((a) => a.value);
  return values.some((v) => v.toLowerCase() === "core.hookspath") && !values.some((v) => GIT_CONFIG_READS.has(v));
}

function write(event: WriteEvent, ctx: ClassifyContext): ClassifiedAction[] {
  const mentions = pathMentions(event.path, event.cwd, ctx, GUARDED_PATHS.config, false);
  return mentions.map((m) => classified("write.config", { pattern: m.id }));
}

/** Editing permission config, hooks or home instructions: CFG rows of the authority table. */
export const config: Family = { verbs: new Set([...READ_ONLY, ...REMOVERS, ...IN_PLACE, ...COPIERS, "tee", "git", "claude", ...DECLARERS, ...STORERS, "env"]), bash, write };
