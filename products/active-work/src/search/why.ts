import { existsSync } from 'node:fs';
import { commitLineage, openSessionGraph, type CommitLinks, type SessionGraph } from '@titan-design/session-graph';
import { repoForCwd } from '@titan-design/session-read';
import { UsageError } from '../errors.js';
import type { CommandRunner } from '../utils/git-gh.js';
import { initiativeOf } from './brief-sessions.js';
import type { Shown } from '../sessions/visibility.js';

/**
 * `why <path>:<range>` (TP-2771): the commits `git blame` names for the lines at HEAD, and for each
 * the PR its squash subject ends with, the tasks behind it and the sessions that did the work. A
 * session or task is served only when the caller's `Shown` serves its initiative.
 */

interface WhyTarget {
  path: string;
  start: number;
  end: number;
}

interface WhyCommit {
  sha: string;
  subject: string;
  /** The blamed lines this commit last changed, as `a` or `a-b` runs. */
  lines: string[];
  prNumber: number | null;
  prRefs: string[];
  tasks: { taskId: string; initiative: string | null; step: string }[];
  sessions: { sessionId: string; step: string; title: string | null; initiative: string | null }[];
  /** Rows this caller may not see, counted and never named. */
  hidden: number;
}

const TARGET = /^(.+):(\d+)(?:-(\d+))?$/;
const PORCELAIN_HEADER = /^([0-9a-f]{40}) \d+ (\d+)/;
const PR_SUBJECT = /\(#(\d+)\)\s*$/;
const SESSION_TRAILER = /^Agent-Session:[ \t]*(\S+)[ \t]*$/gim;
const REFS_LINE = /^Refs:[ \t]*(.+)$/im;
const TASK_ID = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const RECORD_END = '\x1e';
const FIELD_END = '\x00';

export function parseWhyTarget(target: string): WhyTarget {
  const match = TARGET.exec(target);
  const start = Number(match?.[2]);
  const end = match?.[3] === undefined ? start : Number(match[3]);
  if (!match || start < 1 || end < start) throw new UsageError(`expected <path>:<line> or <path>:<start>-<end>, got ${target}`);
  return { path: match[1], start, end };
}

async function git(run: CommandRunner, cwd: string, args: string[]): Promise<string> {
  const result = await run('git', args, { cwd });
  if (result.code !== 0) throw new UsageError(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** Final line numbers per commit, in blame order; the `-L` range is read at HEAD only. */
function parseBlame(porcelain: string): Map<string, number[]> {
  const bySha = new Map<string, number[]>();
  for (const line of porcelain.split('\n')) {
    const header = PORCELAIN_HEADER.exec(line);
    if (!header) continue;
    const lines = bySha.get(header[1]) ?? bySha.set(header[1], []).get(header[1])!;
    lines.push(Number(header[2]));
  }
  return bySha;
}

function runs(lines: readonly number[]): string[] {
  const sorted = [...lines].sort((a, b) => a - b);
  const out: string[] = [];
  let first = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) continue;
    const last = sorted[i - 1];
    out.push(first === last ? `${first}` : `${first}-${last}`);
    first = sorted[i];
  }
  return out;
}

async function readMessages(run: CommandRunner, cwd: string, shas: readonly string[]): Promise<Map<string, string>> {
  const out = await git(run, cwd, ['log', '--no-walk=unsorted', '--format=%H%x00%B%x1e', ...shas]);
  const messages = new Map<string, string>();
  for (const record of out.split(RECORD_END)) {
    const text = record.replace(/^\n/, '');
    const split = text.indexOf(FIELD_END);
    if (split > 0) messages.set(text.slice(0, split), text.slice(split + 1));
  }
  return messages;
}

/** What a commit message says about its origin: the `Agent-Session:` trailer, the PR and the `Refs:` tasks. */
function linksOf(message: string, repoName: string | null): CommitLinks & { subject: string } {
  const subject = message.split('\n', 1)[0] ?? '';
  const pr = PR_SUBJECT.exec(subject);
  return {
    subject,
    prNumber: pr ? Number(pr[1]) : null,
    repoName,
    trailerSessionIds: [...new Set(Array.from(message.matchAll(SESSION_TRAILER), (m) => m[1]))],
    refTaskIds: [...new Set(REFS_LINE.exec(message)?.[1]?.match(TASK_ID) ?? [])],
  };
}

interface BlamedCommit {
  sha: string;
  lines: string[];
  message: string;
}

async function blameCommits(run: CommandRunner, cwd: string, target: WhyTarget): Promise<BlamedCommit[]> {
  const range = `${target.start},${target.end}`;
  const bySha = parseBlame(await git(run, cwd, ['blame', '--porcelain', '-L', range, 'HEAD', '--', target.path]));
  const messages = await readMessages(run, cwd, [...bySha.keys()]);
  return [...bySha].map(([sha, lines]) => ({ sha, lines: runs(lines), message: messages.get(sha) ?? '' }));
}

function servedLineage(graph: SessionGraph, commit: BlamedCommit, repoName: string | null, input: WhyInput): WhyCommit {
  const { shown, activeRoot } = input;
  const { subject, ...links } = linksOf(commit.message, repoName);
  const lineage = commitLineage(graph, links);
  const tasks = lineage.tasks.filter((task) => shown(task.initiative));
  const sessions = lineage.sessions
    .map((s) => ({ sessionId: s.sessionId, step: s.step, title: s.title, initiative: initiativeOf(s, activeRoot) }))
    .filter((s) => shown(s.initiative));
  const hidden = lineage.tasks.length - tasks.length + lineage.sessions.length - sessions.length;
  return { sha: commit.sha, subject, lines: commit.lines, prNumber: links.prNumber, prRefs: lineage.prRefs, tasks, sessions, hidden };
}

interface WhyInput {
  target: WhyTarget;
  cwd: string;
  dbPath: string;
  activeRoot: string;
  shown: Shown;
  run: CommandRunner;
}

/** With no graph on disk the commits and PR numbers still come back, with no tasks or sessions. */
export async function why(input: WhyInput): Promise<WhyCommit[]> {
  const commits = await blameCommits(input.run, input.cwd, input.target);
  const repoName = repoForCwd(input.cwd);
  if (!existsSync(input.dbPath)) return commits.map((commit) => noLineage(commit, repoName));
  const graph = openSessionGraph(input.dbPath, { readonly: true });
  try {
    return commits.map((commit) => servedLineage(graph, commit, repoName, input));
  } finally {
    graph.db.close();
  }
}

function noLineage(commit: BlamedCommit, repoName: string | null): WhyCommit {
  const { subject, prNumber } = linksOf(commit.message, repoName);
  return { sha: commit.sha, subject, lines: commit.lines, prNumber, prRefs: [], tasks: [], sessions: [], hidden: 0 };
}
