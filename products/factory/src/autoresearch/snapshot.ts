import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { PREFIX } from "./ratchet.js";

export type DatedGit = (args: readonly string[], cwd: string, env?: Readonly<Record<string, string>>) => Promise<string>;

const SHA = /^[0-9a-f]{40}$/;
const IDENTITY = ["-c", "user.name=autoresearch", "-c", "user.email=autoresearch@example.invalid"];

/** One ref-name segment: a leading dot or a `..` would let git read it as something other than a plain name. */
const isName = (value: string) => /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith(".") && !value.includes("..");

interface SnapshotName {
  ratchetPrefix: string;
  target: string;
  runId: string;
  k: number;
  /** The branch `origin`'s HEAD names, read once per session. */
  defaultBranch: string;
}

interface SnapshotRefs {
  tag: string;
  branch: string;
}

/**
 * Checked on the branch about to be pushed, not only on how it was named, so no change to the naming can aim the push
 * at main, the default branch or the ratchet namespace. Each refusal has its own code so a test can tell them apart.
 */
export function assertSnapshotBranch(branch: string, ratchetPrefix: string, defaultBranch: string): void {
  if (branch === "refs/heads/main") throw new Error(`[snapshot-main] ${branch} is never a snapshot branch`);
  if (branch === `refs/heads/${defaultBranch}`) throw new Error(`[snapshot-default] ${branch} is the default branch`);
  if (branch.startsWith(`refs/heads/${ratchetPrefix}/`)) throw new Error(`[snapshot-ratchet] ${branch} is in the ratchet namespace`);
}

/** The `-snap` suffix keeps the branch out of `refs/heads/<ratchetPrefix>/`, where git could not hold it beside the run's ratchet. */
export function snapshotRefs({ ratchetPrefix, target, runId, k, defaultBranch }: SnapshotName): SnapshotRefs {
  if (!PREFIX.test(ratchetPrefix)) throw new Error(`[snapshot-prefix] "${ratchetPrefix}" is not a ratchet prefix`);
  if (!Number.isInteger(k) || k < 1 || !isName(target) || !isName(runId)) throw new Error(`[snapshot-ref] target "${target}", run "${runId}" and m${k} name no snapshot`);
  const refs = { tag: `refs/tags/ar/${target}/${runId}/m${k}`, branch: `refs/heads/${ratchetPrefix}-snap/${runId}/m${k}` };
  assertSnapshotBranch(refs.branch, ratchetPrefix, defaultBranch);
  return refs;
}

/** Exit 1 is git's "no"; any other failure, such as an unknown object, is thrown rather than read as "no". */
export async function isAncestor(git: DatedGit, tree: string, ancestor: string, of: string): Promise<boolean> {
  return git(["merge-base", "--is-ancestor", ancestor, of], tree).then(
    () => true,
    (error: { code?: unknown }) => {
      if (error.code === 1) return false;
      throw error;
    },
  );
}

const remoteHead = async (git: DatedGit, tree: string, ref: string) => (await git(["ls-remote", "origin", ref], tree)).split(/\s/)[0] ?? "";

interface CutSnapshot extends SnapshotName {
  /** The integration tree: a checkout of the target repo whose `origin` holds the ratchet. */
  tree: string;
  /** The ratchet head being cut; it becomes the tag. */
  sha: string;
  ratchetRef: string;
  /** Repo-relative directory the log commit writes `<runId>/m<k>.md` into. */
  logDir: string;
  /** The rendered log: aggregates only. */
  log: string;
  /** The target's frozen globs, as git `:(glob)` pathspecs. */
  frozen: readonly string[];
  /** The step's first start: the log commit's dates, so a retried cut rebuilds the same sha. */
  at: string;
}

interface Cut extends SnapshotRefs {
  sha: string;
  logSha: string;
}

function logPathOf({ logDir, runId, k }: CutSnapshot): string {
  const segments = logDir.split("/");
  if (!segments.every((segment) => isName(segment))) throw new Error(`[snapshot-log] "${logDir}" is not a repo-relative directory`);
  return `${logDir}/${runId}/m${k}.md`;
}

/** Only a sha the remote ratchet holds may be tagged, so a snapshot never publishes work the ratchet never kept. */
async function assertOnRatchet(git: DatedGit, cut: CutSnapshot): Promise<void> {
  const remote = await remoteHead(git, cut.tree, cut.ratchetRef);
  if (remote === cut.sha) return;
  if (remote === "") throw new Error(`[snapshot-sha] ${cut.ratchetRef} is not on origin`);
  await git(["fetch", "--quiet", "origin", cut.ratchetRef], cut.tree).catch((error: unknown) => {
    throw new Error(`[pin-fetch] git fetch origin ${cut.ratchetRef} failed in ${cut.tree}: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!(await isAncestor(git, cut.tree, cut.sha, remote))) throw new Error(`[snapshot-sha] ${cut.sha} is not on ${cut.ratchetRef} at ${remote}`);
}

/** Built in a scratch index, so no checkout moves and an evaluator sharing the tree is never disturbed. */
async function logCommit(git: DatedGit, cut: CutSnapshot, logPath: string): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "ar-snapshot-"));
  try {
    const file = join(scratch, "log.md");
    writeFileSync(file, cut.log);
    const index = { GIT_INDEX_FILE: join(scratch, "index") };
    const blob = await git(["hash-object", "-w", "--no-filters", file], cut.tree);
    await git(["read-tree", cut.sha], cut.tree, index);
    await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${logPath}`], cut.tree, index);
    const tree = await git(["write-tree"], cut.tree, index);
    const message = `ar: snapshot m${cut.k} of ${cut.runId}`;
    return await git([...IDENTITY, "commit-tree", tree, "-p", cut.sha, "-m", message], cut.tree, { GIT_AUTHOR_DATE: cut.at, GIT_COMMITTER_DATE: cut.at });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function refuseFrozenLog(git: DatedGit, cut: CutSnapshot, logSha: string): Promise<void> {
  if (cut.frozen.length === 0) return;
  const pathspecs = cut.frozen.map((glob) => `:(glob)${glob}`);
  const hit = await git(["diff", "--name-only", cut.sha, logSha, "--", ...pathspecs], cut.tree);
  if (hit !== "") throw new Error(`[snapshot-log-frozen] the log path ${hit} is frozen`);
}

/**
 * One atomic push with an empty lease on each ref: both are created or neither is, and neither is ever moved. git
 * reads a ref already at the pushed sha as up to date, so a retried cut succeeds; a ref anywhere else is refused.
 */
async function pushCreateOnly(git: DatedGit, tree: string, { tag, branch, sha, logSha }: Cut): Promise<void> {
  const pushing = git(["push", "--quiet", "--atomic", `--force-with-lease=${tag}:`, `--force-with-lease=${branch}:`, "origin", `${sha}:${tag}`, `${logSha}:${branch}`], tree);
  const failure = await pushing.then(() => undefined, (error: unknown) => error);
  if (failure === undefined) return;
  for (const [ref, want] of [[tag, sha], [branch, logSha]] as const) {
    const remote = await remoteHead(git, tree, ref);
    if (remote !== "" && remote !== want) throw new Error(`[snapshot-exists] ${ref} is at ${remote}, not ${want}`);
  }
  // Nothing in the way: a hook, a ruleset or the network refused it, and the atomic push left both refs absent.
  throw failure;
}

/** Tags a kept ratchet sha and pushes a branch one log commit past it, for the snapshot PR's head. */
export async function cutSnapshot(git: DatedGit, cut: CutSnapshot): Promise<Cut> {
  const refs = snapshotRefs(cut);
  if (!SHA.test(cut.sha)) throw new Error(`[snapshot-sha] ${cut.sha} is not a full commit sha`);
  if (Number.isNaN(Date.parse(cut.at))) throw new Error(`[snapshot-at] ${cut.at} cannot date the log commit`);
  const logPath = logPathOf(cut);
  await assertOnRatchet(git, cut);
  const logSha = await logCommit(git, cut, logPath);
  await refuseFrozenLog(git, cut, logSha);
  const done = { ...refs, sha: cut.sha, logSha };
  await pushCreateOnly(git, cut.tree, done);
  return done;
}

interface SnapshotPr {
  repo: RepoSlug;
  /** The snapshot branch as a full ref. */
  branch: string;
  base: string;
  target: string;
  phase: string;
  k: number;
  /** The rendered log: aggregates only. */
  body: string;
}

/** `openPr` returns an existing PR for the head, so a retried cut opens nothing new. */
export async function openSnapshotPr(port: Pick<GitHubPort, "openPr">, request: SnapshotPr): Promise<{ pr: number }> {
  const head = request.branch.replace(/^refs\/heads\//, "");
  const title = `ar ${request.target} ${request.phase}-m${request.k}`;
  const { pr } = await port.openPr(request.repo, { head, base: request.base, title, body: request.body });
  return { pr: pr.number };
}

interface SnapshotRegistration {
  repo: RepoSlug;
  pr: number;
  task: string;
  /** A configured seat name; the run id appears only in the PR body. */
  implementer: string;
  reviewer?: string;
  slice: string;
}

/** The in-process `shepherd.register`; a repeat for the same PR returns the registered run. */
type SnapshotRegister = (request: SnapshotRegistration) => Promise<{ runId: string; created: boolean }>;

interface RegisterSnapshot extends Omit<SnapshotRegistration, "slice"> {
  phase: string;
  k: number;
}

export async function registerSnapshot(register: SnapshotRegister, { phase, k, reviewer, ...request }: RegisterSnapshot): Promise<{ shepherdRunId: string }> {
  const { runId } = await register({ ...request, ...(reviewer !== undefined && { reviewer }), slice: `${phase}-m${k}` });
  return { shepherdRunId: runId };
}
