import { DIRTY_SUFFIX, UNKNOWN_BUILD_SHA } from "./build-info.js";
import { checkoutClosure } from "./checkout-closure.js";
import { touchedPaths } from "./deploy-closure.js";
import { runtimeTouched } from "./deploy-range.js";
import type { CommandResult } from "./service-control.js";
import { runCommand } from "./service-ports.js";

/** How far main has moved past the running build, or why git could not say. */
export type GitBehind = { commitTimes: readonly number[] } | { unknown: string };

/** Reads `runningSha` against origin/main in the deploy checkout. */
export type GitBehindProbe = (runningSha: string) => Promise<GitBehind>;

type Run = (file: string, args: readonly string[]) => Promise<CommandResult | undefined>;

/** The factory build's package dirs, or undefined when they cannot be read. */
type ClosureRead = () => readonly string[] | undefined;

interface LoggedCommit {
  sha: string;
  time: number;
  paths: string[];
}

const RECORD = "\u0001";
const LOG_ARGS = ["log", `--format=${RECORD}%H %ct`, "--name-only", "--no-renames", "--diff-merges=first-parent"];

/**
 * Counts the commits `origin/main` holds that the running build does not and that the deployer would build, with
 * their commit times. Unlike the redeploy.log asks, this sees merges that never asked for a deploy, so a deployer
 * that was never asked still reads behind; a commit the deploy pacer skips (no path reaches the factory build) is
 * not a lag. An unreadable closure counts every commit.
 */
export function gitBehind(checkout: string, run: Run = runCommand, closure: ClosureRead = () => checkoutClosure(checkout), main = "origin/main"): GitBehindProbe {
  return async (runningSha) => {
    if (runningSha === UNKNOWN_BUILD_SHA) return { unknown: "the running build's sha is unknown" };
    const base = runningSha.endsWith(DIRTY_SUFFIX) ? runningSha.slice(0, -DIRTY_SUFFIX.length) : runningSha;
    const result = await run("git", ["-C", checkout, ...LOG_ARGS, `${base}..${main}`]);
    if (result === undefined) return { unknown: "git is not on PATH" };
    if (result.code !== 0) return { unknown: `git log ${base}..${main} exited ${result.code}: ${result.stderr.trim().split("\n")[0] ?? ""}` };
    const commits = parseLog(result.stdout);
    if (commits.some((commit) => !Number.isInteger(commit.time))) return { unknown: "git log returned a commit time that is no number" };
    const dirs = closure();
    const reach = await Promise.all(commits.map((commit) => reachesBuild(checkoutGit(checkout, run), commit, dirs)));
    return { commitTimes: commits.filter((_, index) => reach[index]).map((commit) => commit.time * 1000) };
  };
}

/** A private ref, so the fetch never holds the origin/main lock a running deployer's own `git fetch origin main` needs; `--refmap=` stops git updating origin/main anyway. */
export const WATCHED_MAIN_REF = "refs/titan-factory/watched-main";

/**
 * Serve's reading: the deploy checkout's origin/main moves only when a deploy fetches, so a merge no one deployed
 * would never read behind. A failed fetch reads the last fetched main, and none fetched yet reads as unknown.
 */
export function fetchingGitBehind(checkout: string, run: Run = runCommand, closure: ClosureRead = () => checkoutClosure(checkout)): GitBehindProbe {
  const probe = gitBehind(checkout, run, closure, WATCHED_MAIN_REF);
  return async (runningSha) => {
    await run("git", ["-C", checkout, "fetch", "--quiet", "--no-write-fetch-head", "--refmap=", "origin", `+refs/heads/main:${WATCHED_MAIN_REF}`]);
    return probe(runningSha);
  };
}

function parseLog(stdout: string): LoggedCommit[] {
  return stdout.split(RECORD).flatMap((record) => {
    const [head = "", ...paths] = record.split("\n");
    if (head.trim() === "") return [];
    const [sha = "", time = ""] = head.trim().split(" ");
    return [{ sha, time: Number(time), paths: paths.filter((path) => path !== "") }];
  });
}

/** The deployer's own test, per commit: a path in the build closure, less release-only manifest bumps. */
async function reachesBuild(git: (args: readonly string[]) => Promise<CommandResult>, commit: LoggedCommit, closure: readonly string[] | undefined): Promise<boolean> {
  if (closure === undefined) return true;
  const touched = touchedPaths(commit.paths, closure);
  if (touched.length === 0) return false;
  return (await runtimeTouched(git, touched, `${commit.sha}^`, commit.sha)).length > 0;
}

const checkoutGit =
  (checkout: string, run: Run) =>
  async (args: readonly string[]): Promise<CommandResult> =>
    (await run("git", ["-C", checkout, ...args])) ?? { code: 127, stdout: "", stderr: "git is not on PATH" };
