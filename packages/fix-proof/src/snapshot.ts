import * as path from "node:path";
import { GIT_SAFETY, RunError, type Shas } from "./context.js";
import type { Exec } from "./exec.js";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function remainingMs(deadline: number): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new RunError("timeout");
  return left;
}

async function gitIn(exec: Exec, cwd: string, args: readonly string[], deadline: number, what: string): Promise<string> {
  const result = await exec("git", [...GIT_SAFETY, ...args], { cwd, timeoutMs: remainingMs(deadline) });
  if (result.status === null) remainingMs(deadline);
  if (result.status !== 0) throw new RunError(`${what} failed (exit ${result.status ?? "signal"})`);
  return result.stdout;
}

/** Resolves both refs to full commit shas in source, so every snapshot holds the same two commits. */
export async function resolveShas(exec: Exec, source: string, refs: Shas, deadline: number): Promise<Shas> {
  const resolve = async (ref: string, flag: string) => {
    const sha = (await gitIn(exec, source, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], deadline, `resolving ${flag}`)).trim();
    if (!FULL_SHA.test(sha)) throw new RunError(`resolving ${flag} gave no full sha`);
    return sha;
  };
  return { base: await resolve(refs.base, "--base"), head: await resolve(refs.head, "--head") };
}

/**
 * Fetches both commits from source into a fresh bare repo at dest. A fresh repo carries none of source's config, attributes,
 * hooks or loose objects, so nothing code wrote into another snapshot can reach a git call made on this one.
 */
export async function snapshotRepo(exec: Exec, source: string, shas: Shas, dest: string, deadline: number): Promise<void> {
  await gitIn(exec, path.dirname(dest), ["init", "--bare", "-q", dest], deadline, "creating a snapshot");
  const refspecs = [`${shas.base}:refs/fix-proof/base`, `${shas.head}:refs/fix-proof/head`];
  await gitIn(exec, dest, ["fetch", "-q", "--no-tags", "--no-write-fetch-head", source, ...refspecs], deadline, "fetching a snapshot");
}
