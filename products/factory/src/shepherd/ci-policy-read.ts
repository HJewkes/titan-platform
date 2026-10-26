import type { GitHubPort, RepoSlug } from "@titan-design/github";
import type { CiPolicy } from "@titan-design/session-read";
import { statusOf } from "../required-checks.js";
import { CI_POLICY_UNREAD_PREFIX, ciPolicyChanges, shownLine, type CiPolicyFile, type CiPolicyFileChange } from "./ci-policy-changes.js";

/** Folds case and trailing dots or spaces, which some filesystems ignore, so `.GitHub.` is still `.github`. */
export function isGithubPath(path: string): boolean {
  const first = path.split("/")[0] ?? "";
  return first.toLowerCase().replace(/[ .]+$/, "") === ".github";
}

/** Each file costs two reads, so a weakened line on a PR touching many `.github/` files reads the first few and names the rest unread. */
const MAX_CI_POLICY_FILES = 10;

interface CiPolicyRefs {
  repo: RepoSlug;
  base: string;
  head: string;
}

type SidesRead = { file: CiPolicyFile } | { unread: string };

/** A file absent on one side was added or deleted, so that side reads as empty. */
async function readSides(port: GitHubPort, { repo, base, head }: CiPolicyRefs, path: string): Promise<SidesRead> {
  try {
    const [before, after] = await Promise.all([port.getFile(repo, path, base), port.getFile(repo, path, head)]);
    return { file: { path, before: before?.content ?? "", after: after?.content ?? "" } };
  } catch (error) {
    return { unread: `${CI_POLICY_UNREAD_PREFIX}${shownLine(path)} are unreadable: ${statusOf(error)}` };
  }
}

/** The changed lines of `githubPaths` read at base and head; a read that fails is named unread, and the weakened gate still opens on the line alone. */
async function readCiPolicyChanges(port: GitHubPort, refs: CiPolicyRefs, githubPaths: readonly string[]): Promise<{ changes: CiPolicyFileChange[]; unread: string[] }> {
  const reads = await Promise.all(githubPaths.slice(0, MAX_CI_POLICY_FILES).map((path) => readSides(port, refs, path)));
  const unread = reads.flatMap((read) => ("unread" in read ? [read.unread] : []));
  const skipped = githubPaths.length - MAX_CI_POLICY_FILES;
  if (skipped > 0) unread.push(`${CI_POLICY_UNREAD_PREFIX}${skipped} more .github/ files were not read`);
  return { changes: ciPolicyChanges(reads.flatMap((read) => ("file" in read ? [read.file] : []))), unread };
}

interface ClosedRead {
  baseRef: string;
  paths: readonly string[];
  /** Facts already read at their closed value; an undefined entry is a fact that read. */
  unread: (string | undefined)[];
}

/** The facts read closed so far, joined by the D21 file reads; only a weakened line reads files, and only it yields D21 lines. */
export async function withCiPolicyRead(
  port: GitHubPort,
  input: { repo: RepoSlug; head: string; ciPolicy?: CiPolicy },
  { baseRef, paths, unread }: ClosedRead,
): Promise<{ unreadFacts?: string[]; ciPolicyChanges?: CiPolicyFileChange[] }> {
  const weakened = input.ciPolicy?.kind === "weakened";
  const refs = { repo: input.repo, base: baseRef, head: input.head };
  const policy: { changes?: CiPolicyFileChange[]; unread: string[] } = weakened ? await readCiPolicyChanges(port, refs, paths.filter(isGithubPath)) : { unread: [] };
  const unreadFacts = [...unread, ...policy.unread].filter((fact) => fact !== undefined);
  return { ...(unreadFacts.length > 0 && { unreadFacts }), ...(policy.changes && { ciPolicyChanges: policy.changes }) };
}
