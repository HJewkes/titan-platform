import { GITHUB_ACTIONS_APP_ID, headCheckFindings, isPassing, latestPerName, type CheckFinding, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import { readBaseRequiredChecks } from "../required-checks.js";

/** Only GitHub Actions runs at `sha` judge main CI there. */
export function actionsRunsAt(runs: readonly CheckRun[], sha: string): CheckRun[] {
  return runs.filter((run) => run.headSha === sha && run.appId === GITHUB_ACTIONS_APP_ID);
}

/**
 * Drops each cancelled run that a newer run of its name superseded, as workflow concurrency does to a run when a later
 * push starts; "newer" is the latest start, then the higher id. Any other superseded run still counts.
 */
export function withoutSupersededCancels(runs: readonly CheckRun[]): CheckRun[] {
  const newest = new Set(latestPerName(runs).map((run) => run.id));
  return runs.filter((run) => run.conclusion !== "cancelled" || newest.has(run.id));
}

/** The base branch's required contexts with their app pins; no `MainRules` means every Actions check judges main. */
export interface MainRules {
  contexts: readonly string[];
  pins: Readonly<Record<string, readonly number[]>>;
}

/** `rules` is undefined for no rules and for an unreadable answer alike, so an API failure can never narrow the checks that judge a red main; `readable` tells the two apart. */
export async function readMainRules(port: GitHubPort, repo: RepoSlug, base: string): Promise<{ rules: MainRules | undefined; readable: boolean }> {
  const read = await readBaseRequiredChecks(port, repo, base);
  if (!read.readable) return { rules: undefined, readable: false };
  const { contexts, pins } = read.checks;
  return { rules: contexts.length > 0 ? { contexts, pins: pins ?? {} } : undefined, readable: true };
}

export type RulesReader = () => Promise<MainRules | undefined>;

/**
 * The base branch's required contexts, read once a clean answer arrives. No PR, or any unreadable answer, is undefined
 * for that poll, so every Actions check judges main as before and an API failure never thaws a red main.
 */
export function mainRulesReader(port: GitHubPort, repo: RepoSlug, pr: number | undefined): RulesReader {
  let settled: { rules: MainRules | undefined } | undefined;
  return async () => {
    if (pr === undefined) return undefined;
    if (settled !== undefined) return settled.rules;
    try {
      const { baseRef } = await port.getPr(repo, pr);
      const read = await readMainRules(port, repo, baseRef);
      if (read.readable) settled = { rules: read.rules };
      return read.rules;
    } catch {
      return undefined;
    }
  };
}

interface MainJudgement {
  findings: CheckFinding[];
  /** How many runs were judged; zero means nothing has run yet. */
  counted: number;
  /** Runs red outside the required contexts, which are recorded and never freeze. */
  warnings: CheckRun[];
}

/** Without rules, every Actions run at `sha` judges it; with them, only each required context's run from its pinned app (Actions when unpinned). */
export function judgeMain(sha: string, runs: readonly CheckRun[], rules: MainRules | undefined): MainJudgement {
  const actions = withoutSupersededCancels(actionsRunsAt(runs, sha));
  if (rules === undefined) return { findings: headCheckFindings({ headSha: sha, contexts: [], runs: actions, requiredApps: [GITHUB_ACTIONS_APP_ID] }), counted: actions.length, warnings: [] };
  const perContext = rules.contexts.map((name) => judgeContext(sha, runs, name, rules.pins[name] ?? [GITHUB_ACTIONS_APP_ID]));
  const warnings = actions.filter((run) => !rules.contexts.includes(run.name) && run.status === "completed" && !isPassing(run));
  return { findings: perContext.flatMap((one) => one.findings), counted: perContext.reduce((sum, one) => sum + one.counted, 0), warnings };
}

function judgeContext(sha: string, runs: readonly CheckRun[], name: string, apps: readonly number[]): Pick<MainJudgement, "findings" | "counted"> {
  const named = withoutSupersededCancels(runs.filter((run) => run.headSha === sha && run.name === name && run.appId !== null && apps.includes(run.appId)));
  return { findings: headCheckFindings({ headSha: sha, contexts: [name], runs: named, requiredApps: apps }), counted: named.length };
}

export const warningOf = (warnings: readonly CheckRun[]): string | undefined => (warnings.length > 0 ? `not required, so not blocking: ${[...new Set(warnings.map((run) => run.name))].join(", ")}` : undefined);
