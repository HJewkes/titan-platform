import type { WriteEvent } from "../event.js";
import { commandMentions, pathMentions } from "../mentions.js";
import type { Mention } from "../mentions.js";
import { GUARDED_PATHS } from "../paths.js";
import type { SimpleCommand } from "../shell/commands.js";
import { parseGit } from "../shell/git.js";
import type { WordToken } from "../shell/lexer.js";
import { basename } from "../shell/path.js";
import { classified } from "../spellings.js";
import type { SpellingId } from "../spellings.js";
import type { ClassifiedAction, ClassifyContext, Family } from "../types.js";

/** Config reads are allowed by the table; only edits are CFG. */
const READ_ONLY = new Set(["cat", "head", "tail", "less", "grep", "rg", "jq", "ls", "stat", "diff", "wc", "test", "[", "[["]);
const REMOVERS = new Set(["rm", "unlink", "truncate", "chmod"]);
const IN_PLACE = new Set(["sed", "gsed", "perl"]);
/** Copiers whose sources are only read; `mv` also removes its sources, so every mention counts. */
const COPIERS: Record<string, Set<string>> = {
  cp: new Set(["-t", "-S"]),
  install: new Set(["-t", "-m", "-o", "-g", "-S"]),
  ln: new Set(["-t", "-S"]),
  mv: new Set(["-t", "-S"]),
};
const CLAUDE_CLI: Record<string, Set<string>> = {
  config: new Set(["set", "add", "remove"]),
  mcp: new Set(["add", "add-json", "remove"]),
  plugin: new Set(["install", "uninstall"]),
};
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
  if (Object.hasOwn(COPIERS, name)) return writesTo(cmd, m) ? "bash.config.cp-mv-ln" : null;
  return REMOVERS.has(name) ? "bash.config.remove" : "bash.config.mention";
}

/** `sed` without `-i` only reads; `perl` without `-i` is still an interpreter. */
function inPlaceSpelling(cmd: SimpleCommand, name: string): SpellingId | null {
  if (cmd.args.some((a) => /^-[a-zA-Z]*i/.test(a.value) || a.value.startsWith("--in-place"))) return "bash.config.in-place";
  return name === "perl" ? "bash.config.interpreter" : null;
}

function writesTo(cmd: SimpleCommand, m: Mention): boolean {
  return cmd.name === "mv" || m.word === null || m.word === destination(cmd);
}

/** The destination operand of `cp`, `install`, `ln` or `mv`: the `-t` directory, else the last operand. */
function destination(cmd: SimpleCommand): WordToken | null {
  const valueOpts = COPIERS[cmd.name ?? ""];
  if (!valueOpts) return null;
  const operands: WordToken[] = [];
  for (let i = 0; i < cmd.args.length; i++) {
    const word = cmd.args[i] as WordToken;
    if (word.value === "-t") return cmd.args[i + 1] ?? null;
    if (word.value.startsWith("--target-directory=")) return word;
    if (valueOpts.has(word.value)) i++;
    else if (!word.value.startsWith("-")) operands.push(word);
  }
  return operands.length >= 2 ? (operands.at(-1) ?? null) : null;
}

/** `cp /tmp/settings.json ~/.claude/` writes `~/.claude/settings.json`: the destination joined with each source's name. */
function copyIntoMentions(cmd: SimpleCommand, ctx: ClassifyContext): Mention[] {
  const dest = destination(cmd);
  if (!dest) return [];
  const into = dest.value.replace(/^--target-directory=/, "").replace(/\/+$/, "");
  const sources = cmd.args.filter((a) => a !== dest && !a.value.startsWith("-"));
  const joined = sources.map((s) => ({ ...s, value: `${into}/${basename(s.value)}` }));
  const copied = { ...cmd, args: joined, env: {}, redirects: [] };
  return commandMentions(copied, ctx, GUARDED_PATHS.config).map((m) => ({ ...m, word: null }));
}

function namedWrite(cmd: SimpleCommand, ctx: ClassifyContext): ClassifiedAction | null {
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
export const config: Family = { bash, write };
