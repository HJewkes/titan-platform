/**
 * Deterministic intent extraction from raw (often compound) Bash commands —
 * ported behavior-preservingly from active-work's session miner
 * (AW-22 → AW-23).
 */

import os from 'node:os';
import path from 'node:path';
import { splitCommands, type ShellWord } from './shell-split.js';

/** Build artifacts and vendored trees are never interesting file touches. */
export const IGNORED_PATH =
  /(^|\/)(node_modules|\.git|dist|build|\.next|coverage|\.turbo|storybook-static)(\/|$)/;

export const TASK_ID = /\b([A-Z]{1,5}-\d+)\b/;

/** A branch-name capture (unquoted token). */
const BRANCH = '[\'"]?([^\\s\'"&|;]+)';
const RE_SWITCH = new RegExp(
  '\\bgit\\s+(?:-C\\s+\\S+\\s+)?(?:checkout|switch)\\s+(?![-\\d])' + BRANCH,
);
const RE_WORKTREE = new RegExp('\\bgit\\s+worktree\\s+add\\b[^&|;]*?\\s-b\\s+' + BRANCH);
const RE_PUSH_BRANCH = new RegExp('\\bgit\\s+push\\b[^&|;]*?\\borigin\\s+(?:-u\\s+)?' + BRANCH);
const RE_PR_HEAD = new RegExp('\\bgh\\s+pr\\s+create\\b[^&|;]*?--head\\s+' + BRANCH);
const RE_MERGE = /\bgh\s+pr\s+merge\s+(\d+)/;

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
  '\\bgit[^\\S\\n]+(?:-C[^\\S\\n]+\\S+[^\\S\\n]+)?' +
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
const RE_PR_BASE = new RegExp('\\bgh\\s+pr\\s+create\\b[^&|;]*?--base[=\\s]+' + BRANCH);
const RE_DELETE = new RegExp('\\bgit\\s+branch\\s+-[dD]\\s+' + BRANCH);
const RE_COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;
const RE_PUSH = /\bgit\s+(?:-C\s+\S+\s+)?push\b/;

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
  const expanded = target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;
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
function captureBranch(raw: string): BranchCapture {
  const created = RE_NEW_WITH_START.exec(raw);
  // A heredoc body is data, not commands: the only start-point this ever found
  // inside one was a fragment of a quoted source file.
  if (created)
    return { name: created[1], base: raw.includes('<<') ? null : baseOrNull(created[2]) };

  const worktree = RE_WORKTREE.exec(raw);
  if (worktree) return { name: worktree[1], base: null };

  const prHead = RE_PR_HEAD.exec(raw);
  if (prHead) return { name: prHead[1], base: baseOrNull(RE_PR_BASE.exec(raw)?.[1]) };

  return { name: (RE_PUSH_BRANCH.exec(raw) ?? RE_SWITCH.exec(raw))?.[1], base: null };
}

export function parseGitIntent(raw: string): GitIntent | null {
  if (!raw.includes('git') && !raw.includes('gh ')) return null;

  const branch = captureBranch(raw);
  const captured = cleanBranch(branch.name);
  const setBranch = isRealBranch(captured) ? captured : null;
  const deleted = cleanBranch(RE_DELETE.exec(raw)?.[1]);
  const mergedPr = RE_MERGE.exec(raw)?.[1];

  return {
    setBranch,
    // A branch is never its own base: `gh pr create --head x --base x` is not a
    // real shape, but a mis-parse producing one would be a self-loop.
    branchBase: setBranch && branch.base !== setBranch ? branch.base : null,
    deletedBranch: deleted.length > 0 ? deleted : null,
    mergedPr: mergedPr ? Number(mergedPr) : null,
    commit: RE_COMMIT.test(raw),
    push: RE_PUSH.test(raw),
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

/** A word that reads as a subcommand (`pr`, `checks`, `task`), not an operand, number, id or path. */
const SUBCOMMAND = /^[a-z][a-z0-9_-]*$/;
const MAX_SUBCOMMANDS = 2;
/** Programs whose arguments are operands, so `echo y` stays `echo`. */
const OPERAND_ONLY = new Set([
  'awk', 'cat', 'chmod', 'cp', 'echo', 'find', 'grep', 'head', 'jq', 'ls', 'mkdir', 'mv',
  'printf', 'rg', 'rm', 'sed', 'sleep', 'sort', 'tail', 'tee', 'test', 'touch', 'wc',
]);
const PREFIX_WORDS = new Set(['(', '{', '!', 'if', 'then', 'else', 'do', 'while', 'until', 'time']);
/** Subshell and group closers stay glued to the last word of a command. */
const CLOSERS = /[)}]+$/;
/** Wrappers that run the next program, with the count of operands each takes first (`timeout 60`). */
const LOOK_THROUGH = new Map([
  ['builtin', 0], ['command', 0], ['env', 0], ['nice', 0], ['nohup', 0], ['timeout', 1],
]);
/** Wrapper options whose value is the next word (`timeout -s KILL`, `nice -n 5`, `env -u NAME`). */
const WRAPPER_VALUE_FLAGS = new Set([
  '-s', '--signal', '-k', '--kill-after', '-n', '--adjustment', '-u', '--unset', '-C', '--chdir', '-S', '--split-string',
]);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh', 'deno', 'bun', 'ruby', 'perl']);
/** Interpreter options after which the next word is inline code, a module or stdin, never a script. */
const CODE_FLAGS = new Set(['-', '-c', '-e', '-E', '-m', '-p', '--eval', '--print']);
const FILE_LIKE = /\/|\.[A-Za-z0-9]+$/;
/** `gh api` options whose value is the next word, so a `-f` body or `--jq` filter never reads as the endpoint. */
const GH_API_VALUE_FLAGS = new Set([
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '-q', '--jq', '-t', '--template',
  '--input', '--cache', '-p', '--preview', '--hostname',
]);
/** gh sends POST instead of GET when one of these adds a request body. */
const GH_API_BODY_FLAGS = new Set(['-f', '--raw-field', '-F', '--field', '--input']);
/** A collection whose next path segment names one item (a number, sha, login or branch). */
const ID_AFTER = new Set([
  'artifacts', 'branches', 'check-runs', 'check-suites', 'comments', 'commits', 'deployments', 'hooks', 'issues',
  'jobs', 'labels', 'milestones', 'orgs', 'pulls', 'releases', 'reviews', 'runs', 'teams', 'users', 'workflows',
]);
/** Everything after these is a file path or ref name, never a resource word. */
const PATH_AFTER = new Set(['contents', 'ref', 'refs']);
const RESOURCE_WORD = /^[a-z][a-z_-]*$/;
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const OUT_REDIRECT = /^(?:\d+|&)?>[>|]?(.*)$/;
const IN_REDIRECT = /^\d*<(.*)$/;

/**
 * The program and up to two subcommand words of each simple command in `raw`
 * (`gh pr checks`, `git log`), plus `>basename` for every file it writes via a
 * redirect or `tee`. `cd` is dropped wherever it sits in the chain; duplicates
 * keep their first position.
 */
export function commandHeads(raw: string): string[] {
  const heads: string[] = [];
  for (const segment of splitCommands(raw)) {
    for (const head of segmentHeads(segment)) if (!heads.includes(head)) heads.push(head);
  }
  return heads;
}

function segmentHeads(words: readonly ShellWord[]): string[] {
  const { command, targets } = separateRedirects(words);
  const head = headOf(command);
  const program = head[0];
  const teeTargets = program === 'tee' ? command.slice(1).filter((w) => !w.text.startsWith('-')).map((w) => w.text) : [];
  const writes = [...targets, ...teeTargets].filter((t) => t.length > 0 && !t.startsWith('/dev/'));
  return [...(program && program !== 'cd' ? [head.join(' ')] : []), ...writes.map((t) => `>${writeName(t)}`)];
}

/** The parent directory names which log a dated file belongs to, so `logs/a/2026-01-01.md` gives `a/2026-01-01.md`. */
function writeName(target: string): string {
  const parent = path.basename(path.dirname(target));
  const name = path.basename(target);
  return parent && parent !== '.' && parent !== '/' ? `${parent}/${name}` : name;
}

interface Redirected {
  command: ShellWord[];
  targets: string[];
}

/** An fd dup such as `2>&1` names no file, so it is neither a target nor part of the command. */
function separateRedirects(words: readonly ShellWord[]): Redirected {
  const out: Redirected = { command: [], targets: [] };
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const output = word.quoted ? null : OUT_REDIRECT.exec(word.text);
    const input = word.quoted || output ? null : IN_REDIRECT.exec(word.text);
    const redirect = output ?? input;
    if (!redirect) {
      out.command.push(word);
      continue;
    }
    const operand = redirect[1] || words[++i]?.text || '';
    if (output && !operand.startsWith('&')) out.targets.push(operand);
  }
  return out;
}

/** The program followed by its subcommand words, or empty when the command has no program. */
function headOf(words: readonly ShellWord[]): string[] {
  let start = 0;
  while (start < words.length && !words[start]!.quoted && isPrefix(words[start]!.text)) start++;
  start = skipLookThrough(words, start);
  const program = words[start];
  if (!program || program.quoted) return [];
  const name = path.basename(program.text.replace(/^\(+/, '').replace(CLOSERS, ''));
  if (!name) return [];
  if (OPERAND_ONLY.has(name) || CLOSERS.test(program.text)) return [name];
  const args = words.slice(start + 1);
  return specialHead(name, args) ?? [name, ...subcommands(args)];
}

function subcommands(args: readonly ShellWord[]): string[] {
  const parts: string[] = [];
  for (const word of args) {
    const text = word.text.replace(CLOSERS, '');
    if (parts.length >= MAX_SUBCOMMANDS || word.quoted || !SUBCOMMAND.test(text)) break;
    parts.push(text);
    if (text !== word.text) break;
  }
  return parts;
}

/** `gh api` and interpreters carry their signal in a path operand, which the subcommand rule drops. */
function specialHead(name: string, args: readonly ShellWord[]): string[] | null {
  if (name === 'gh' && args[0]?.text === 'api' && !args[0].quoted) return ['gh', 'api', ...ghApiHead(args.slice(1))];
  const script = INTERPRETERS.has(name) ? scriptOf(args) : null;
  return script ? [name, script] : null;
}

/** The script's basename when the first operand looks like a file; `python3 -c …` and `python3 -` have none. */
function scriptOf(args: readonly ShellWord[]): string | null {
  for (const word of args) {
    if (word.quoted || CODE_FLAGS.has(word.text)) return null;
    if (word.text.startsWith('-')) continue;
    const text = word.text.replace(CLOSERS, '');
    return FILE_LIKE.test(text) ? path.basename(text) : null;
  }
  return null;
}

/** The HTTP method, then the endpoint's resource shape; flag values never enter the head. */
function ghApiHead(args: readonly ShellWord[]): string[] {
  let method: string | undefined;
  let endpoint: string | undefined;
  let body = false;
  for (let i = 0; i < args.length; i++) {
    const flag = /^(--[a-z-]+|-[A-Za-z])=?(.*)$/.exec(args[i]!.text);
    if (!flag) {
      endpoint ??= args[i]!.text.replace(CLOSERS, '');
      continue;
    }
    const [, option = '', inline] = flag;
    const value = inline || (GH_API_VALUE_FLAGS.has(option) ? args[++i]?.text : undefined);
    if (option === '-X' || option === '--method') method = /^[A-Za-z]+$/.test(value ?? '') ? value?.toUpperCase() : method;
    body ||= GH_API_BODY_FLAGS.has(option);
  }
  const shape = endpoint ? resourceShape(endpoint) : '';
  return [method ?? (body ? 'POST' : 'GET'), ...(shape ? [shape] : [])];
}

/** `repos/o/r/commits/abc/check-runs` gives `commits/check-runs`: owner, repo and item ids are dropped. */
function resourceShape(endpoint: string): string {
  const segments = (endpoint.split('?')[0] ?? '').split('/').filter(Boolean);
  const words: string[] = [];
  for (let i = afterOwnerRepo(segments); i < segments.length; i++) {
    const segment = segments[i]!;
    if (!RESOURCE_WORD.test(segment)) continue;
    words.push(segment);
    if (PATH_AFTER.has(segment)) break;
    if (ID_AFTER.has(segment)) i++;
  }
  return words.join('/') || (segments[0] === 'repos' ? 'repos' : '');
}

/** `repos/$REPO/pulls` names owner and repo in one segment, so the skip stops at a collection word. */
function afterOwnerRepo(segments: readonly string[]): number {
  if (segments[0] !== 'repos') return 0;
  let i = 1;
  while (i < 3 && i < segments.length && !ID_AFTER.has(segments[i]!)) i++;
  return i;
}

/** Wrappers such as `builtin` and `timeout 60` run the next program, so the head (and the `cd` rule) belongs to that program. */
function skipLookThrough(words: readonly ShellWord[], from: number): number {
  let start = from;
  for (;;) {
    const wrapper = words[start];
    const operands = wrapper && !wrapper.quoted ? LOOK_THROUGH.get(wrapper.text) : undefined;
    if (operands === undefined) return start;
    start = skipWrapperArgs(words, start + 1, operands);
  }
}

/** Env assignments are skipped too, because `env A=1 x` runs `x`. */
function skipWrapperArgs(words: readonly ShellWord[], from: number, operands: number): number {
  let i = from;
  let left = operands;
  while (i < words.length && !words[i]!.quoted) {
    const text = words[i]!.text;
    if (WRAPPER_VALUE_FLAGS.has(text)) i += 2;
    else if (text.startsWith('-') || ENV_ASSIGN.test(text)) i++;
    else if (left-- > 0) i++;
    else break;
  }
  return i;
}

function isPrefix(text: string): boolean {
  return PREFIX_WORDS.has(text) || ENV_ASSIGN.test(text);
}
