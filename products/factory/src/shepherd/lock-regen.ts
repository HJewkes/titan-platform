import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { BranchName, CarryRefusal, cacheFor, ensureCache, must, reasonOf, remoteBase, serialized, type CacheHandle, type GitCachePorts } from "./tree-carry.js";

const LOCK_REGEN_STEP = "sh-lock-regen";
export const LOCK_REGEN_STEPS: readonly StepDeclaration[] = [{ id: LOCK_REGEN_STEP, kind: "dispatch" }];

export const CLOSURE_LOCK_PATH = "products/factory/src/registry/closure.lock.json";
/** Git's well-known empty tree: as `attr.tree` it reads no `.gitattributes`, so the merge is GitHub's plain text merge. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const SUBJECT = "Merge main and regenerate closure.lock.json";

/** Rebuilds the lock in a checkout of `commit` from the cache at `gitDir`; resolves to the tree with the regenerated lock. */
export type ClosureRegen = (at: { gitDir: string; commit: string }, signal?: AbortSignal) => Promise<string>;

export interface LockRegenDeps {
  port: GitHubPort;
  ports: GitCachePorts;
  regen: ClosureRegen;
  /** True for a repo where Shepherd never writes to a branch. */
  advisory?: (repo: string) => boolean;
  /** The fetch and push URL for `repo`; absent means GitHub over https. */
  remote?: (repo: string) => string;
}

const LockRegenInput = z.object({ repo: z.string(), pr: z.number().int().positive(), headSha: z.string() });
type LockRegenInput = z.infer<typeof LockRegenInput>;

/** `conflicted` is what GitHub's text merge of the head and `tip` leaves conflicting: the count TP-5732's metric reads. */
const LockRegenResult = z.object({
  outcome: z.enum(["pushed", "declined"]),
  reason: z.string(),
  conflicted: z.array(z.string()).optional(),
  tip: z.string().optional(),
  newHead: z.string().optional(),
});
type LockRegenResult = z.infer<typeof LockRegenResult>;

interface Remote extends CacheHandle {
  input: LockRegenInput;
  pr: PullRequest;
}

const declined = (reason: string, extra: Partial<LockRegenResult> = {}): LockRegenResult => ({ outcome: "declined", reason, ...extra });
const headRef = (remote: Remote): string => `refs/heads/${remote.pr.headRef}`;

/** Why the PR's branch is not Shepherd's to push to now, or undefined when it is. */
function prMiss(pr: PullRequest, input: LockRegenInput): string | undefined {
  if (pr.state !== "open") return "the pull request is not open";
  if (pr.headSha !== input.headSha) return `the head is ${pr.headSha}, not ${input.headSha}`;
  if (pr.headRepo?.toLowerCase() !== input.repo.toLowerCase()) return "the head is on a fork";
  return BranchName.safeParse(pr.headRef).success ? undefined : "the head branch name is not a plain branch name";
}

const remoteHead = async (remote: Remote): Promise<string | undefined> => (await must(remote.git, remote.dir, ["ls-remote", remote.url, headRef(remote)])).split("\t")[0] || undefined;

/** The text merge's tree and its conflicted paths, or undefined when the head merges onto `tip` cleanly. */
async function textMerge(remote: Remote, tip: string): Promise<{ tree: string; files: string[] } | undefined> {
  const args = ["-c", `attr.tree=${EMPTY_TREE}`, "merge-tree", "--write-tree", "--name-only", "--no-messages", remote.input.headSha, tip];
  const merged = await remote.git(remote.dir, args);
  if (merged.code === 0) return undefined;
  if (merged.code !== 1) throw new CarryRefusal("merge-tree", merged.code);
  const [tree = "", ...files] = merged.stdout.split("\n").filter(Boolean);
  return { tree, files: [...new Set(files)] };
}

/** Pushes `commit` with a plain push, which only fast-forwards, and counts it only when the branch reads back there. */
async function pushFastForward(remote: Remote, commit: string): Promise<string | undefined> {
  if ((await remoteHead(remote)) !== remote.input.headSha) return "the branch moved before the push";
  if ((await remote.git(remote.dir, ["push", "--quiet", "--porcelain", remote.url, `${commit}:${headRef(remote)}`])).code !== 0) return "the fast-forward push was rejected";
  return (await remoteHead(remote)) === commit ? undefined : `the branch does not read back at ${commit} after the push`;
}

/** Merges the base tip into the head as text; only a merge whose one conflict is the lock is regenerated, built and pushed. */
async function mergeAndPush(remote: Remote, regen: ClosureRegen): Promise<LockRegenResult> {
  const { git, dir, url, input, pr } = remote;
  await ensureCache(remote);
  await must(git, dir, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, input.headSha, `+refs/heads/${pr.baseRef}:${remoteBase(pr.baseRef)}`]);
  const tip = await must(git, dir, ["rev-parse", remoteBase(pr.baseRef)]);
  const merged = await textMerge(remote, tip);
  if (merged === undefined) return declined(`the head merges onto ${pr.baseRef} at ${tip} without a conflict`, { tip });
  const facts = { conflicted: merged.files, tip };
  if (merged.files.length !== 1 || merged.files[0] !== CLOSURE_LOCK_PATH) return declined("a file other than closure.lock.json conflicts", facts);
  const parents = ["-p", input.headSha, "-p", tip];
  const unresolved = await must(git, dir, ["commit-tree", merged.tree, ...parents, "-m", SUBJECT]);
  const tree = await regen({ gitDir: dir, commit: unresolved });
  const commit = await must(git, dir, ["commit-tree", tree, ...parents, "-m", SUBJECT]);
  const refused = await pushFastForward(remote, commit);
  return refused === undefined ? { outcome: "pushed", reason: `merged ${pr.baseRef} at ${tip} and regenerated closure.lock.json`, newHead: commit, ...facts } : declined(refused, facts);
}

/** A PR that never touched the lock cannot conflict on it, so only such a PR reaches the git cache. */
async function attempt(deps: LockRegenDeps, input: LockRegenInput): Promise<LockRegenResult> {
  if (deps.advisory?.(input.repo)) return declined(`${input.repo} is advisory`);
  const files = await deps.port.listPrFiles(input.repo, input.pr);
  if (!files.some((file) => file.path === CLOSURE_LOCK_PATH)) return declined("the pull request does not change closure.lock.json");
  const pr = await deps.port.getPr(input.repo, input.pr);
  const miss = prMiss(pr, input);
  if (miss !== undefined) return declined(miss);
  const remote: Remote = { ...cacheFor(input.repo, { ports: deps.ports, ...(deps.remote && { remote: deps.remote }) }), input, pr };
  return serialized(remote.dir, () => mergeAndPush(remote, deps.regen));
}

/** Every failure declines with a fixed-vocabulary reason, since the result is a stored step output that can reach a public PR. */
export function regenerateLock(deps: LockRegenDeps, input: LockRegenInput): Promise<LockRegenResult> {
  return attempt(deps, input).catch((error: unknown) => declined(reasonOf(error)));
}

export function lockRegenRoute(now: () => number, deps: LockRegenDeps): StepRoute {
  return codeRoute(LOCK_REGEN_STEP, now, (input: LockRegenInput) => regenerateLock(deps, LockRegenInput.parse(input)));
}

/**
 * TP-5732: before a conflict wakes a fixer, Shepherd merges the base itself when the lock is the only file in conflict, and
 * regenerates the lock on the merged tree instead of picking a side. True means a new head is up. A record from before this
 * step skips it, so an older run replays as it ran.
 */
export async function lockRegenerated(ctx: WorkflowContext, input: { repo: RepoSlug; pr: number; headSha: string }): Promise<boolean> {
  const next = ctx.historyNext();
  if (next !== undefined && !stepIdMatches(LOCK_REGEN_STEP, next)) return false;
  return (await step(ctx, `${LOCK_REGEN_STEP}:${input.headSha}`, input, LockRegenResult)).outcome === "pushed";
}
