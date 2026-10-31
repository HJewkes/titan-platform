import { isPassing, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import { judgeMain, readMainRules, type MainRules } from "./main-verdict.js";

/** The most first-parent base commits read back from the base head toward the CI base, looking for a green one. */
const GREEN_WALK = 20;

interface MainFixedRead {
  port: GitHubPort;
  repo: RepoSlug;
  baseRef: string;
  baseSha: string;
  /** The since-moved base commit the red head's CI ran against. */
  ciBase: string;
  failing: readonly string[];
}

const passes = (runs: readonly CheckRun[], name: string): boolean => runs.some((run) => run.name === name && run.status === "completed" && isPassing(run));

/** Green on every required context, and every check the head fails passes here too. */
async function greenFor(read: MainFixedRead, sha: string, rules: MainRules | undefined): Promise<boolean> {
  const runs = await read.port.latestCheckRuns(read.repo, sha);
  return judgeMain(sha, runs, rules).findings.length === 0 && read.failing.every((name) => passes(runs, name));
}

/**
 * The newest first-parent base commit after `ciBase` that is green where the head is red, when none of the head's
 * failing checks passed at `ciBase` itself (TP-4650). The red then came with the stale base the merge ref was built on,
 * not with the PR, so a merge-up is the repair. Check runs name no paths, so this stands in for "the failure sits
 * outside the PR's diff". Undefined when the rules are unreadable, a failing check passed at the CI base, or the walk
 * finds no green commit before reaching it.
 */
export async function mainFixedSince(read: MainFixedRead): Promise<string | undefined> {
  const { rules, readable } = await readMainRules(read.port, read.repo, read.baseRef);
  if (!readable || read.failing.length === 0) return undefined;
  const atCiBase = await read.port.latestCheckRuns(read.repo, read.ciBase);
  if (read.failing.some((name) => passes(atCiBase, name))) return undefined;
  let sha: string | undefined = read.baseSha;
  for (let hop = 0; hop < GREEN_WALK && sha !== undefined && sha !== read.ciBase; hop++) {
    if (await greenFor(read, sha, rules)) return sha;
    sha = (await read.port.getCommit(read.repo, sha)).parents[0];
  }
  return undefined;
}
