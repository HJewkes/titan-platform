import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import type { FactoryContext } from "../context.js";
import { classifyRegistered, register, type Registered } from "./commands.js";
import { BUMP_BRANCH_PREFIX } from "./consumer-bump.js";
import { RELEASE_IMPLEMENTER, releaseTask } from "./release.js";

/** Registers the changesets PR the way `shepherd register` would, with no fixer: no agent wrote it, so none can fix it. */
export async function registerVersionPackages(ctx: FactoryContext, repo: RepoSlug, pr: number): Promise<Registered> {
  return register({ repo, pr, task: releaseTask(repo), implementer: RELEASE_IMPLEMENTER, kind: "unknown", policy: { fixer: false } }, ctx);
}

/** The registration's implementer: the factory toolchain sweep wrote this PR, so a wake for it is never handled. */
export const TOOLCHAIN_IMPLEMENTER = "toolchain-fanout";

function toolchainTask(repo: RepoSlug): string {
  return `${repo.split("/")[1] ?? repo}/toolchain`;
}

/** Registers a toolchain adoption PR with no fixer, since no agent can fix a plan the sweep wrote, and owner-gated, since it edits other repos' release workflows. */
export async function registerToolchainAdoption(ctx: FactoryContext, repo: RepoSlug, pr: number): Promise<Registered> {
  return register({ repo, pr, task: toolchainTask(repo), implementer: TOOLCHAIN_IMPLEMENTER, kind: "unknown", policy: { fixer: false, merge: "owner-gate", ownerGateReason: "owner-asked" } }, ctx);
}

/** The registration's implementer: the consumer bump sweep wrote this PR, so a wake for it is never handled. */
export const CONSUMER_BUMP_IMPLEMENTER = "bump-consumers";

/** The only files a consumer bump writes: manifests and the lockfile regenerated from them. */
const BUMP_FILE_NAMES: ReadonlySet<string> = new Set(["package.json", "pnpm-lock.yaml", "package-lock.json"]);

/** Anyone can open a PR from a fork under a bump branch's name; only a head in the consumer repo itself, which takes push rights, can be the sweep's. */
export function headInRepo(pr: PullRequest, repo: RepoSlug): boolean {
  return pr.headRepo?.toLowerCase() === repo.toLowerCase();
}

/**
 * Registers a consumer bump PR with no fixer and nothing wider, so the consumer seat's own policy decides its merge.
 * A bump branch's name proves nothing about its content, so the PR counts as a bump only when its head is in the repo and
 * every file it changes is a manifest or lockfile it edits in place; G10 then classes it like a seat's own registration.
 */
export async function registerConsumerBump(ctx: FactoryContext, repo: RepoSlug, pr: number): Promise<Registered> {
  if (!ctx.shepherd) throw new Error("registering a consumer bump needs the shepherd routes");
  await assertBumpShaped(ctx.shepherd.port, repo, pr);
  const registered = await register({ repo, pr, task: `${repo.split("/")[1] ?? repo}/bump-consumers`, implementer: CONSUMER_BUMP_IMPLEMENTER, kind: "unknown", policy: { fixer: false } }, ctx);
  return classifyRegistered(ctx, registered);
}

async function assertBumpShaped(port: GitHubPort, repo: RepoSlug, pr: number): Promise<void> {
  const found = await port.getPr(repo, pr);
  if (!headInRepo(found, repo) || !found.headRef.startsWith(BUMP_BRANCH_PREFIX)) throw new Error(`${repo}#${pr} is not on a ${BUMP_BRANCH_PREFIX}* branch in ${repo}`);
  const files = await port.listPrFiles(repo, pr);
  const foreign = files.filter((file) => file.status !== "modified" || file.previousPath !== undefined || !BUMP_FILE_NAMES.has(file.path.split("/").pop() ?? ""));
  const named = foreign.length > 0 ? foreign.map((file) => file.path).join(", ") : "nothing";
  if (files.length === 0 || foreign.length > 0) throw new Error(`${repo}#${pr} changes ${named}, not only manifests and lockfiles`);
}
