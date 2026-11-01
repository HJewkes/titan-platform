import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "@titan-design/fix-proof";
import type { BundleGit } from "../review-pr/bundle.js";
import type { CorpusV3Row } from "./select.js";
import { planHiddenTests } from "./write-case.js";

/** `follow-up` is a title-matched fix; `fix-touch` is any later fix PR touching the same files within 14 days. */
export type FixSource = "follow-up" | "fix-touch";

type LaterFixReason = "fix-not-in-corpus" | "fix-not-descendant" | "fix-no-tests" | "fix-not-applicable";

/** A corpus row with the file-overlap fix links, which the selector's row type does not read. */
export type LaterFixRow = CorpusV3Row & { fix_touch_14d?: readonly number[] };

interface LaterFixCandidate {
  pr: number;
  fixSource: FixSource;
  row: CorpusV3Row;
}

interface LaterFixRejection {
  pr: number;
  fixSource: FixSource;
  reason: LaterFixReason;
}

type CorpusIndex = ReadonlyMap<string, CorpusV3Row>;

const keyOf = (repo: string, pr: number): string => `${repo}#${pr}`;

/** Fix PRs resolve within the case's own repo, so the index keys on repo and PR number together. */
export function indexCorpus(rows: readonly CorpusV3Row[]): CorpusIndex {
  return new Map(rows.map((row) => [keyOf(row.repo, row.pr_number), row]));
}

function linkedFixes(row: LaterFixRow): Map<number, FixSource> {
  const links = new Map<number, FixSource>();
  // Follow-ups go first so a PR listed by both sources keeps the stricter one.
  for (const pr of row.follow_up_fixes) if (!links.has(pr)) links.set(pr, "follow-up");
  for (const pr of row.fix_touch_14d ?? []) if (!links.has(pr)) links.set(pr, "fix-touch");
  links.delete(row.pr_number);
  return links;
}

/** A case's later fix PRs in PR order, each resolved to its own corpus row; one the corpus lacks is rejected, not thrown. */
export function laterFixCandidates(row: LaterFixRow, index: CorpusIndex): { candidates: LaterFixCandidate[]; rejected: LaterFixRejection[] } {
  const candidates: LaterFixCandidate[] = [];
  const rejected: LaterFixRejection[] = [];
  const ordered = [...linkedFixes(row)].sort(([a], [b]) => a - b);
  for (const [pr, fixSource] of ordered) {
    const fixRow = index.get(keyOf(row.repo, pr));
    if (fixRow === undefined) rejected.push({ pr, fixSource, reason: "fix-not-in-corpus" });
    else candidates.push({ pr, fixSource, row: fixRow });
  }
  return { candidates, rejected };
}

export interface CorrectedRefInput {
  /** The scratch clone; never the owner's clone, and nothing here fetches. */
  clone: string;
  /** Holds the temporary worktree and patch, both removed before the call returns. */
  scratchDir: string;
  merge: string;
  fixPr: number;
  fixBase: string;
  fixMerge: string;
  exec: Exec;
}

type CorrectedRef = { ok: true; sha: string } | { ok: false; reason: "fix-not-descendant" | "fix-not-applicable" };

const GIT_TIMEOUT_MS = 2 * 60_000;
// Pinned so two builds of the same fix on the same merge give the same sha.
const REFERENCE_IDENTITY = ["GIT_AUTHOR_NAME=titan-evals", "GIT_AUTHOR_EMAIL=evals@titan.invalid", "GIT_AUTHOR_DATE=2000-01-01T00:00:00Z"];
const COMMITTER_IDENTITY = ["GIT_COMMITTER_NAME=titan-evals", "GIT_COMMITTER_EMAIL=evals@titan.invalid", "GIT_COMMITTER_DATE=2000-01-01T00:00:00Z"];

async function git(input: CorrectedRefInput, args: readonly string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return input.exec("git", ["-C", input.clone, ...args], { cwd: input.clone, timeoutMs: GIT_TIMEOUT_MS });
}

async function mustGit(input: CorrectedRefInput, args: readonly string[]): Promise<string> {
  const result = await git(input, args);
  if (result.status !== 0) throw new Error(`git ${args[0] ?? ""} failed (exit ${result.status ?? "signal"}): ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function isDescendant(input: CorrectedRefInput): Promise<boolean> {
  const result = await git(input, ["merge-base", "--is-ancestor", input.merge, input.fixMerge]);
  if (result.status === 0 || result.status === 1) return result.status === 0;
  throw new Error(`git merge-base failed (exit ${result.status ?? "signal"}): ${result.stderr.trim()}`);
}

// No --3way: a hunk that does not apply as written rejects the fix rather than committing conflict markers.
async function applyAndCommit(input: CorrectedRefInput, tree: string, patch: string): Promise<CorrectedRef> {
  await mustGit(input, ["diff", "--binary", `--output=${patch}`, input.fixBase, input.fixMerge]);
  const applied = await input.exec("git", ["-C", tree, "apply", "--index", patch], { cwd: tree, timeoutMs: GIT_TIMEOUT_MS });
  if (applied.status !== 0) return { ok: false, reason: "fix-not-applicable" };
  const message = `later fix #${input.fixPr} on ${input.merge.slice(0, 10)}`;
  const commitArgs = ["-C", tree, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message];
  const committed = await input.exec("env", [...REFERENCE_IDENTITY, ...COMMITTER_IDENTITY, "git", ...commitArgs], { cwd: tree, timeoutMs: GIT_TIMEOUT_MS });
  if (committed.status !== 0) throw new Error(`git commit failed (exit ${committed.status ?? "signal"}): ${committed.stderr.trim()}`);
  const sha = await input.exec("git", ["-C", tree, "rev-parse", "HEAD"], { cwd: tree, timeoutMs: GIT_TIMEOUT_MS });
  return { ok: true, sha: sha.stdout.trim() };
}

/**
 * The accepted merge plus the fix's own diff, committed in the scratch clone. The candidate never sees history
 * between the merge and the fix, so a fix's tests count only if they hold on the merge with the fix alone.
 */
export async function buildCorrectedRef(input: CorrectedRefInput): Promise<CorrectedRef> {
  if (!(await isDescendant(input))) return { ok: false, reason: "fix-not-descendant" };
  mkdirSync(input.scratchDir, { recursive: true });
  const temp = mkdtempSync(join(input.scratchDir, "later-fix-"));
  const tree = join(temp, "tree");
  try {
    await mustGit(input, ["worktree", "add", "--quiet", "--detach", tree, input.merge]);
    return await applyAndCommit(input, tree, join(temp, "fix.patch"));
  } finally {
    // Deleting the directory and pruning also clears a worktree whose add half-failed, which `worktree remove` refuses.
    rmSync(temp, { recursive: true, force: true });
    await git(input, ["worktree", "prune"]);
  }
}

type FixTests = { ok: true; tests: string[]; carried: string[] } | { ok: false; reason: "fix-no-tests" };

/** The fix's tests and support files, planned as fix-proof plans any PR; a fix that changes no test has nothing to grade. */
export async function fixTests(port: BundleGit, fixBase: string, fixMerge: string): Promise<FixTests> {
  const plan = await planHiddenTests(port, fixBase, fixMerge);
  if (plan.tests.length === 0) return { ok: false, reason: "fix-no-tests" };
  return { ok: true, tests: plan.tests, carried: plan.carried };
}
