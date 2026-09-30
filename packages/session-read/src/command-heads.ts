/** The `command_heads` signal: what each simple command in a Bash call runs, reduced to a low-cardinality head. */

import path from 'node:path';
import { splitCommands, type ShellWord } from './shell-split.js';

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
