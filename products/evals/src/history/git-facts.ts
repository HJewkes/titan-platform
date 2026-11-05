import type { ChangedFile } from "@titan-design/review-panel";
import type { MainCommit } from "../corpus/git.js";

/** Read-only questions history asks one repo's bare mirror; nothing here fetches or writes a ref. */
export interface MirrorGit {
  /** First-parent history of `refs/heads/main`, newest first. */
  mainLog(): MainCommit[];
  /** The commit `refs/pull/<n>/head` points at, if the mirror has it. */
  pullHead(number: number): string | undefined;
  mergeBase(a: string, b: string): string | undefined;
  numstat(from: string, to: string): ChangedFile[] | undefined;
}

/** Path rules of the Python corpus builder (pr-shape pilot 2026-10-03), kept verbatim so counts match. */
const TEST_PATH_RE = /\.(test|spec)\.|__tests__\/|__fixtures__\/|golden\/|(^|\/)tests?\/|\.snap$|__snapshots__\/|__screenshots__\//;

type SizeBand = "xs" | "s" | "m" | "l";

export function sizeBand(lines: number): SizeBand {
  if (lines <= 20) return "xs";
  if (lines <= 100) return "s";
  if (lines <= 400) return "m";
  return "l";
}

export interface CommitFacts {
  merge_sha: string;
  base_sha: string;
  start_sha: string;
  head_sha: string;
  paths: string[];
  test_paths: string[];
  has_tests: boolean;
  files: number;
  additions: number;
  deletions: number;
  size_band: SizeBand;
}

export type MissingReason = "not-on-main" | "no-pull-head" | "no-merge-base" | "no-diff";

type FactsResult = { facts: CommitFacts } | { missing: MissingReason };

const squashNumber = (subject: string): number | undefined => mapMatch(/\(#(\d+)\)\s*$/.exec(subject));
const mergeNumber = (subject: string): number | undefined => mapMatch(/^Merge pull request #(\d+)\b/.exec(subject));
const mapMatch = (match: RegExpExecArray | null): number | undefined => (match?.[1] === undefined ? undefined : Number(match[1]));

/** The PR number a main-line subject names, from a squash `(#N)` suffix or a `Merge pull request #N` subject. */
export const landedPrNumber = (subject: string): number | undefined => squashNumber(subject) ?? mergeNumber(subject);

/**
 * The commit on main that landed PR `number`, with its first parent. A later commit can reuse the
 * subject, so the earliest match wins; in a first-parent log the next entry is the first parent.
 */
export function mergeCommitFor(log: readonly MainCommit[], number: number): { merge: string; base: string } | undefined {
  for (let i = log.length - 1; i >= 0; i--) {
    const commit = log[i];
    if (!commit || (squashNumber(commit.subject) !== number && mergeNumber(commit.subject) !== number)) continue;
    const base = log[i + 1]?.sha;
    return base === undefined ? undefined : { merge: commit.sha, base };
  }
  return undefined;
}

export function commitFacts(git: MirrorGit, number: number): FactsResult {
  const landed = mergeCommitFor(git.mainLog(), number);
  if (!landed) return { missing: "not-on-main" };
  const head = git.pullHead(number);
  if (!head) return { missing: "no-pull-head" };
  const start = git.mergeBase(landed.base, head);
  if (!start) return { missing: "no-merge-base" };
  const files = git.numstat(landed.base, landed.merge);
  if (!files) return { missing: "no-diff" };
  return { facts: { merge_sha: landed.merge, base_sha: landed.base, start_sha: start, head_sha: head, ...diffFacts(files) } };
}

function diffFacts(files: readonly ChangedFile[]): Pick<CommitFacts, "paths" | "test_paths" | "has_tests" | "files" | "additions" | "deletions" | "size_band"> {
  const paths = files.map((file) => file.path).sort();
  const testPaths = paths.filter((path) => TEST_PATH_RE.test(path));
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  return { paths, test_paths: testPaths, has_tests: testPaths.length > 0, files: files.length, additions, deletions, size_band: sizeBand(additions + deletions) };
}
