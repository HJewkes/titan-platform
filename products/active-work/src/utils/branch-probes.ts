import { getGitRunner } from "./git-gh.js";
import type { GhPrListEntry } from "./gh-pr-wire.js";

interface AheadBehind {
  ahead: number | null;
  behind: number | null;
}

/** One-word CI summary of a PR's check rollup; undefined when there are no checks. */
export function summarizeChecks(
  rollup: NonNullable<GhPrListEntry["statusCheckRollup"]>
): string | undefined {
  if (rollup.length === 0) return undefined;
  let pass = 0;
  let fail = 0;
  let pending = 0;
  for (const entry of rollup) {
    const tag = (entry.conclusion ?? entry.state ?? "").toUpperCase();
    if (tag === "SUCCESS") pass++;
    else if (tag === "FAILURE" || tag === "CANCELLED" || tag === "TIMED_OUT")
      fail++;
    else pending++;
  }
  if (fail > 0) return `fail (${fail}/${rollup.length})`;
  if (pending > 0) return `pending (${pending}/${rollup.length})`;
  return `pass (${pass}/${rollup.length})`;
}

export async function isBranchPresent(
  repoPath: string,
  name: string
): Promise<boolean> {
  try {
    const args = [
      "-C",
      repoPath,
      "rev-parse",
      "--verify",
      `refs/heads/${name}`,
    ];
    return (await getGitRunner()("git", args)).code === 0;
  } catch {
    return false;
  }
}

export async function readLastCommitIso(
  repoPath: string,
  name: string
): Promise<string | null> {
  try {
    const res = await getGitRunner()("git", [
      "-C",
      repoPath,
      "log",
      "-1",
      "--format=%cI",
      name,
    ]);
    if (res.code !== 0) return null;
    const stamp = res.stdout.trim();
    return stamp.length > 0 ? stamp : null;
  } catch {
    return null;
  }
}

async function detectDefaultBase(repoPath: string): Promise<string | null> {
  const git = getGitRunner();
  for (const candidate of ["main", "master"]) {
    try {
      const ref = `refs/remotes/origin/${candidate}`;
      const res = await git("git", [
        "-C",
        repoPath,
        "rev-parse",
        "--verify",
        ref,
      ]);
      if (res.code === 0) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Commits the branch is ahead of / behind origin's default branch; nulls when unknown. */
export async function readAheadBehind(
  repoPath: string,
  name: string
): Promise<AheadBehind> {
  const unknown: AheadBehind = { ahead: null, behind: null };
  const base = await detectDefaultBase(repoPath);
  if (!base) return unknown;
  try {
    const range = `origin/${base}...${name}`;
    const args = ["-C", repoPath, "rev-list", "--left-right", "--count", range];
    const res = await getGitRunner()("git", args);
    if (res.code !== 0) return unknown;
    // Output is "<behind>\t<ahead>": left is the base, right is the branch.
    const parts = res.stdout.trim().split(/\s+/);
    if (parts.length !== 2) return unknown;
    const behind = Number(parts[0]);
    const ahead = Number(parts[1]);
    return Number.isFinite(ahead) && Number.isFinite(behind)
      ? { ahead, behind }
      : unknown;
  } catch {
    return unknown;
  }
}
