import { isPassing, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import { actionsRunsAt } from "./main-verdict.js";

/** Step conclusions that end a job red; a step after the first of these is skipped, so the first one is the cause. */
const FAILED_STEP = new Set(["failure", "timed_out", "cancelled"]);

/** The red head whose failing checks are matched against another sha's red. */
export interface RedChecks {
  repo: RepoSlug;
  headSha: string;
  failing: string[];
}

/** The completed red Actions runs at `sha`, newest per name, that `counts` keeps. */
export async function redRunsAt(port: GitHubPort, repo: RepoSlug, sha: string, counts: (run: CheckRun) => boolean = () => true): Promise<CheckRun[]> {
  const runs = actionsRunsAt(await port.latestCheckRuns(repo, sha), sha);
  return runs.filter((run) => run.status === "completed" && !isPassing(run) && counts(run));
}

/** The name of the step that failed `run`'s job; undefined when the steps cannot be read or none failed. */
async function failedStepOf(port: GitHubPort, repo: RepoSlug, run: CheckRun | undefined): Promise<string | undefined> {
  if (run === undefined) return undefined;
  const steps = await port.jobSteps(repo, run.id).catch(() => undefined);
  return steps?.find((step) => step.conclusion !== null && FAILED_STEP.has(step.conclusion))?.name;
}

/**
 * The failing checks of `head` that do not fail in `red` at the same step. A check of the same name can fail for a cause
 * of its own, as an out-of-memory test run under a base that failed only its changeset step; and a step that cannot be
 * read on either side counts as the head's own, since a held wake that should not have been held costs more than a
 * spent repair.
 */
export async function failingNotIn(port: GitHubPort, head: RedChecks, red: readonly CheckRun[]): Promise<string[]> {
  const named = head.failing.filter((name) => red.some((run) => run.name === name));
  if (named.length < head.failing.length) return head.failing.filter((name) => !named.includes(name));
  const headRuns = actionsRunsAt(await port.latestCheckRuns(head.repo, head.headSha), head.headSha);
  const differs = await Promise.all(
    named.map(async (name) => {
      const [here, there] = await Promise.all([failedStepOf(port, head.repo, headRuns.find((run) => run.name === name)), failedStepOf(port, head.repo, red.find((run) => run.name === name))]);
      return here === undefined || here !== there;
    }),
  );
  return named.filter((_, i) => differs[i]);
}
