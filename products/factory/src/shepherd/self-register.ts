import type { RepoSlug } from "@titan-design/github";
import type { FactoryContext } from "../context.js";
import { register, type Registered } from "./commands.js";
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
