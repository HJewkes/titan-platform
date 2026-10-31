import { isPassing, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import { failingNotIn, type FailureReader } from "./failing-step.js";
import { actionsRunsAt, judgeMain, readMainRules, type MainRules } from "./main-verdict.js";

/** The most main-fixed merge-ups one run makes before it wakes the fixer, so a busy base cannot merge up a red head forever. */
export const MAIN_FIXED_MERGE_UPS = 2;
/** Main-fixed merge-ups per run; replaying the run's recorded hold steps in order rebuilds the count after a restart. */
const mergeUps = new WeakMap<object, number>();

/**
 * True once `run` has made its main-fixed merge-ups. Every caller of the hold decision passes this in, so the run's
 * own hold and the await-new-head hook read one answer: a spent run is never held as main-fixed.
 */
export const mainFixedSpent = (run: object): boolean => (mergeUps.get(run) ?? 0) >= MAIN_FIXED_MERGE_UPS;

export function countMainFixedMergeUp(run: object): void {
  mergeUps.set(run, (mergeUps.get(run) ?? 0) + 1);
}

/** The most first-parent base commits read back from the base head toward the CI base, looking for a green one. */
const GREEN_WALK = 20;
/** The most first-parent base commits read back from the CI base, looking for a finished run of each failing check. */
const RED_WALK = 10;

interface MainFixedRead {
  port: GitHubPort;
  repo: RepoSlug;
  headSha: string;
  baseRef: string;
  baseSha: string;
  /** The since-moved base commit the red head's CI ran against. */
  ciBase: string;
  failing: readonly string[];
  failures: FailureReader;
}

const finished = (run: CheckRun): boolean => run.status === "completed" && run.conclusion !== "cancelled";

const passes = (runs: readonly CheckRun[], name: string): boolean => runs.some((run) => run.name === name && run.status === "completed" && isPassing(run));

/** Green on every required context, and every check the head fails passes here too in an Actions run of this commit. */
async function greenFor(read: MainFixedRead, sha: string, rules: MainRules | undefined): Promise<boolean> {
  const runs = await read.port.latestCheckRuns(read.repo, sha);
  const own = actionsRunsAt(runs, sha);
  return judgeMain(sha, runs, rules).findings.length === 0 && read.failing.every((name) => passes(own, name));
}

/**
 * The newest finished Actions run of each failing check at or before the CI base, walking first parents, since a newer
 * push cancels a busy base's queued run. Undefined when any check has no finished run within the walk.
 */
async function lastFinishedRuns(read: MainFixedRead): Promise<CheckRun[] | undefined> {
  const found = new Map<string, CheckRun>();
  let sha: string | undefined = read.ciBase;
  for (let hop = 0; hop < RED_WALK && sha !== undefined && found.size < read.failing.length; hop++) {
    const runs = actionsRunsAt(await read.port.latestCheckRuns(read.repo, sha), sha).filter(finished);
    for (const name of read.failing) {
      const run = runs.find((one) => one.name === name);
      if (run !== undefined && !found.has(name)) found.set(name, run);
    }
    sha = (await read.port.getCommit(read.repo, sha)).parents[0];
  }
  return found.size === read.failing.length ? [...found.values()] : undefined;
}

/** True only when the base's last finished run of every failing check failed at the same step with the same failures. */
async function baseOwnedRed(read: MainFixedRead): Promise<boolean> {
  const last = await lastFinishedRuns(read);
  if (last === undefined || last.some(isPassing)) return false;
  const own = await failingNotIn(read.port, { repo: read.repo, headSha: read.headSha, failing: [...read.failing] }, last, read.failures);
  return own.length === 0;
}

/**
 * The newest first-parent base commit after `ciBase` that is green where the head is red, when the base's last finished
 * run of each failing check, at or before `ciBase`, failed at the same step with the same failures (TP-4650). The red
 * then came with the stale base the merge ref was built on, not with the PR, so a merge-up is the repair. A cancelled
 * or missing run is no evidence either way, so it is walked past, never read as the base's red. Undefined when the
 * rules are unreadable, the base's red is not the head's, or the walk finds no green commit before reaching `ciBase`.
 */
export async function mainFixedSince(read: MainFixedRead): Promise<string | undefined> {
  const { rules, readable } = await readMainRules(read.port, read.repo, read.baseRef);
  if (!readable || read.failing.length === 0 || !(await baseOwnedRed(read))) return undefined;
  let sha: string | undefined = read.baseSha;
  for (let hop = 0; hop < GREEN_WALK && sha !== undefined && sha !== read.ciBase; hop++) {
    if (await greenFor(read, sha, rules)) return sha;
    sha = (await read.port.getCommit(read.repo, sha)).parents[0];
  }
  return undefined;
}
