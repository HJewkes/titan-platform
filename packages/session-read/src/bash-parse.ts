/**
 * Deterministic intent extraction from raw (often compound) Bash commands —
 * ported behavior-preservingly from active-work's session miner
 * (AW-22 → AW-23).
 */

import path from 'node:path';
import { programStart } from './command-heads.js';
import { expandHome } from './expand-home.js';
import { splitCommands, type ShellWord } from './shell-split.js';
export { commandHeads } from './command-heads.js';

/** Build artifacts and vendored trees are never interesting file touches. */
export const IGNORED_PATH =
  /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|\.turbo|storybook-static)(\/|$)/;

export const TASK_ID = /\b([A-Z]{1,5}-\d+)\b/;

/**
 * Every pattern below is anchored at `^` and runs against one simple command
 * from `gitCommands`, never the raw string: a commit message, an `echo`
 * argument or a heredoc body that mentions `git push` is data, not a push.
 */

/** A branch-name capture (unquoted token). */
const BRANCH = '[\'"]?([^\\s\'"&|;]+)';
const RE_SWITCH = new RegExp(
  '^git\\s+(?:-C\\s+\\S+\\s+)?(?:checkout|switch)\\s+(?![-\\d])' + BRANCH,
);
const RE_WORKTREE = new RegExp('^git\\s+worktree\\s+add\\b[^&|;]*?\\s-b\\s+' + BRANCH);
const RE_PUSH_BRANCH = new RegExp('^git\\s+push\\b[^&|;]*?\\borigin\\s+(?:-u\\s+)?' + BRANCH);
const RE_PR_HEAD = new RegExp('^gh\\s+pr\\s+create\\b[^&|;]*?--head\\s+' + BRANCH);
const RE_MERGE = /^gh\s+pr\s+merge\s+(\d+)/;

/**
 * The start-point of `git checkout -b <new> <start>` (AW-104).
 *
 * `[^\S\n]` — whitespace that is not a newline — rather than `\s` throughout:
 * `git checkout -b feat/x` followed on the NEXT LINE by `git add -A` otherwise
 * captures `git` as the start point. Requiring the token to be followed by
 * horizontal space or end-of-line is what rejects the `2` of a trailing
 * `2>&1`, which is the single most common thing in this position.
 */
const RE_NEW_WITH_START = new RegExp(
  '^git[^\\S\\n]+(?:-C[^\\S\\n]+\\S+[^\\S\\n]+)?' +
    '(?:checkout[^\\S\\n]+-[bB]|switch[^\\S\\n]+-c)[^\\S\\n]+' +
    BRANCH +
    '(?:[^\\S\\n]+([A-Za-z0-9._/-]+)(?=[^\\S\\n]|$))?',
);

/**
 * `gh pr create --base <branch>` — the head branch's base, stated outright.
 *
 * This is the source AW-106 said a correct PR/branch link needs. Unlike the
 * temporal join it replaced, nothing is inferred: one command names both ends,
 * so a `cd` into another repo cannot misattribute it.
 */
const RE_PR_BASE = new RegExp('^gh\\s+pr\\s+create\\b[^&|;]*?--base[=\\s]+' + BRANCH);
const RE_DELETE = new RegExp('^git\\s+branch\\s+-[dD]\\s+' + BRANCH);
const RE_COMMIT = /^git\s+(?:-C\s+\S+\s+)?commit\b/;
const RE_PUSH = /^git\s+(?:-C\s+\S+\s+)?push\b/;
const GIT_OR_GH = /^(?:git|gh)$/;
/** A quoted word that could be a ref or path; anything else is prose and is blanked. */
const SINGLE_TOKEN = /^[^\s'"]*$/;

/**
 * Each simple command in `raw` whose program is an unquoted `git` or `gh`,
 * rejoined from that program word on. Heredoc bodies are already gone, and a
 * quoted word with spaces becomes `''`, so a `--head` inside a PR body never
 * reads as a flag.
 */
export function gitCommands(raw: string): string[] {
  const commands: string[] = [];
  for (const words of splitCommands(raw)) {
    const args = words.slice(programStart(words));
    const program = args[0];
    if (program && !program.quoted && GIT_OR_GH.test(program.text.replace(/^\(+/, ''))) {
      const last = args.length - 1;
      const bare = args.map((word, i) => (i === last && i > 0 ? withoutSubshellCloser(word) : word));
      commands.push(bare.map(rejoinWord).join(' ').replace(/^\(+/, ''));
    }
  }
  return commands;
}

/** Drops `)` that closes an enclosing subshell, keeping those balanced inside the word (`$(…)`). */
function withoutSubshellCloser(word: ShellWord): ShellWord {
  if (word.quoted) return word;
  let text = word.text;
  const opens = [...text].filter((c) => c === '(').length;
  let closes = [...text].filter((c) => c === ')').length;
  while (closes > opens && text.endsWith(')')) {
    text = text.slice(0, -1);
    closes--;
  }
  return { text, quoted: false };
}

function rejoinWord(word: ShellWord): string {
  if (!word.quoted) return word.text;
  return SINGLE_TOKEN.test(word.text) ? `'${word.text}'` : "''";
}

function firstMatch(pattern: RegExp, commands: readonly string[]): RegExpExecArray | null {
  for (const command of commands) {
    const match = pattern.exec(command);
    if (match) return match;
  }
  return null;
}

/** Strip leading `cd X && …` so we reach the real command verb. */
export function realCommand(raw: string): string {
  let s = raw.trim();
  for (let i = 0; i < 4; i++) {
    const m = s.match(/^cd\s+[^&;]+(?:&&|;)\s*/);
    if (!m) break;
    s = s.slice(m[0].length).trim();
  }
  return s;
}

/**
 * The directory a compound command's git verb actually runs in.
 *
 * `cd ~/projects/x && git checkout -b feat/y` is the dominant shape in this
 * corpus, and the session's own `cwd` is frequently somewhere else entirely —
 * a state directory, a scratch dir. Attributing the branch to the session's
 * `cwd` therefore named the wrong repo, or none (AW-91). `git -C <dir>` wins
 * over a leading `cd` because it is the more specific of the two.
 */
export function commandCwd(raw: string, sessionCwd: string | null): string | null {
  const dashC = raw.match(/\bgit\s+-C\s+(\S+)/)?.[1];
  const cd = raw.trim().match(/^cd\s+([^&;|]+?)\s*(?:&&|;|$)/)?.[1];
  const target = (dashC ?? cd)?.trim().replace(/^['"]|['"]$/g, '');
  if (!target) return sessionCwd;
  const expanded = expandHome(target);
  if (path.isAbsolute(expanded)) return expanded;
  return sessionCwd ? path.resolve(sessionCwd, expanded) : null;
}

export interface GitIntent {
  setBranch: string | null;
  /** The branch `setBranch` was created from, when the command says so. */
  branchBase: string | null;
  deletedBranch: string | null;
  mergedPr: number | null;
  commit: boolean;
  push: boolean;
}

function cleanBranch(name: string | undefined): string {
  return (name ?? '').replace(/^origin\//, '').replace(/['"]/g, '');
}

/** A capture that is really a ref/flag rather than a branch name. */
function isRealBranch(name: string): boolean {
  return (
    name.length > 0 &&
    name !== 'HEAD' &&
    name !== '/' &&
    !name.startsWith('-') &&
    !name.includes(':')
  );
}

/** A branch sighting plus, where the same command states it, what it forked from. */
interface BranchCapture {
  name: string | undefined;
  base: string | null;
}

function baseOrNull(candidate: string | undefined): string | null {
  const cleaned = cleanBranch(candidate);
  return isRealBranch(cleaned) ? cleaned : null;
}

/**
 * A base is only ever read from the SAME command that named the branch.
 *
 * `git checkout -b x && gh pr create --head y --base main` names two different
 * branches; taking the base from whichever regex happened to match would
 * attach `main` to `x`. Each capture therefore carries its own base or none —
 * which is also why this returns a pair instead of the caller reaching for
 * `RE_PR_BASE` after the fact.
 */
function captureBranch(commands: readonly string[]): BranchCapture {
  const created = firstMatch(RE_NEW_WITH_START, commands);
  if (created) return { name: created[1], base: baseOrNull(created[2]) };

  const worktree = firstMatch(RE_WORKTREE, commands);
  if (worktree) return { name: worktree[1], base: null };

  const prHead = firstMatch(RE_PR_HEAD, commands);
  if (prHead) return { name: prHead[1], base: baseOrNull(RE_PR_BASE.exec(prHead.input)?.[1]) };

  const pushOrSwitch = firstMatch(RE_PUSH_BRANCH, commands) ?? firstMatch(RE_SWITCH, commands);
  return { name: pushOrSwitch?.[1], base: null };
}

export function parseGitIntent(raw: string): GitIntent | null {
  if (!raw.includes('git') && !raw.includes('gh ')) return null;

  const commands = gitCommands(raw);
  const branch = captureBranch(commands);
  const captured = cleanBranch(branch.name);
  const setBranch = isRealBranch(captured) ? captured : null;
  const deleted = cleanBranch(firstMatch(RE_DELETE, commands)?.[1]);
  const mergedPr = firstMatch(RE_MERGE, commands)?.[1];

  return {
    setBranch,
    // A branch is never its own base: `gh pr create --head x --base x` is not a
    // real shape, but a mis-parse producing one would be a self-loop.
    branchBase: setBranch && branch.base !== setBranch ? branch.base : null,
    deletedBranch: deleted.length > 0 ? deleted : null,
    mergedPr: mergedPr ? Number(mergedPr) : null,
    commit: commands.some((command) => RE_COMMIT.test(command)),
    push: commands.some((command) => RE_PUSH.test(command)),
  };
}

/**
 * The `--title` of a `gh pr create`, which is the only place a PR title is
 * stated (AW-104).
 *
 * The title is read out of a shell command, so it still carries that command's
 * quoting: inside double quotes a backtick is written `\``, and storing it raw
 * puts a backslash in the title that GitHub never saw. Only the five characters
 * the shell actually treats as escapable in double quotes are unescaped, and
 * single-quoted titles are taken verbatim, because there `\` is a literal.
 */
export function parsePrCreateTitle(raw: string): string | null {
  if (!raw.includes('gh ')) return null;
  // The double-quoted arm consumes `\"` as a unit; a non-greedy `[\s\S]*?` ends
  // the title at the first escaped quote inside it instead.
  const match =
    /\bgh\s+pr\s+create\b[\s\S]*?--title[=\s]+(?:"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+))/.exec(raw);
  if (!match) return null;
  const [, doubleQuoted, singleQuoted, bare] = match;
  if (doubleQuoted !== undefined) return doubleQuoted.replace(/\\(["$`\\\n])/g, '$1');
  return singleQuoted ?? bare ?? null;
}

/**
 * The task id an `active-work`/`aw` invocation acts on, if any. Unlike the
 * prototype this is NOT scoped to one initiative's slug: the production index
 * spans every initiative and repo-scoping is a query-time concern.
 */
export function parseTaskId(command: string): string | null {
  return parseTaskIntents(command)[0]?.taskId ?? null;
}

export interface TaskIntent {
  taskId: string;
  /** The state the command puts the task in, when it says so outright. */
  status: string | null;
}

/**
 * `<tool> task <verb> <slug> <ID>`, anywhere in a compound command. Matching
 * only at the start of the line misses the dominant real shape, where closing a
 * task is the tail of a chain: `cd repo && gh pr merge 5 && … && active-work
 * task done slug TP-5`. Measured on 366 transcripts, anchoring cost 38 of 63
 * closed tasks.
 */
const RE_TASK = /\b(?:active-work|aw)\s+task\s+([a-z-]+)\s+[^\s&|;]+\s+([A-Z]{1,5}-\d+)((?:\s+[^\s&|;]+){0,2})/g;

/**
 * Every task an `active-work`/`aw` invocation acts on. Two forms state a status
 * unambiguously, and across the same corpus they are the only ones worth
 * reading: `task done <slug> <ID>` (193 uses) and the explicit
 * `task edit <slug> <ID> status <value>` (1). `task add` mints the id inside the
 * tool, so it names no task; every other form is a read.
 *
 * A quoted mention inside `echo` now parses too. That trade is deliberate: a
 * stray reference is a task ref with no status, which is what a read produces
 * anyway, and losing three fifths of real closures is the worse error.
 */
export function parseTaskIntents(command: string): TaskIntent[] {
  const byId = new Map<string, TaskIntent>();
  for (const match of command.matchAll(RE_TASK)) {
    const [, verb, taskId, tail] = match;
    if (!taskId) continue;
    const intent = { taskId, status: statusFrom(verb, tail) };
    const seen = byId.get(taskId);
    if (!seen || (intent.status !== null && seen.status === null)) byId.set(taskId, intent);
  }
  return [...byId.values()];
}

/** The first task the command names, or null. Kept for callers that want one. */
export function parseTaskIntent(command: string): TaskIntent | null {
  return parseTaskIntents(command)[0] ?? null;
}

function statusFrom(verb: string | undefined, tail: string | undefined): string | null {
  if (verb === 'done') return 'done';
  if (verb !== 'edit') return null;
  const words = (tail ?? '').trim().split(/\s+/);
  return words[0] === 'status' ? (words[1] ?? null) : null;
}
