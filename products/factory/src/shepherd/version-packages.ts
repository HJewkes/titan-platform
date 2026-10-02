import { GITHUB_ACTIONS_APP_ID, type GitHubPort, type PullRequest, type RepoSlug } from "@titan-design/github";
import type { FactoryHost } from "../host.js";
import { registerVersionPackages, type ShepherdServices } from "./commands.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";

/** How often `titan-factory serve` looks for a Version Packages PR in each shepherded repo. */
export const RELEASE_SWEEP_MS = 60_000;
/** A head this old with no Actions run never started CI, because the changesets action pushes with GITHUB_TOKEN. */
export const START_CI_AFTER_MS = 2 * 60_000;
export const START_CI_MESSAGE = "Start CI for the Version Packages PR\n\nShepherd pushed this empty commit: a push by the changesets action starts no workflow until the GitHub App (TP-447) pushes instead.";

export interface ReleaseSweepNote {
  repo: RepoSlug;
  pr: number;
  registered?: string;
  startedCi?: string;
  error?: string;
}

/** Registers each open Version Packages PR in a shepherded repo once, and starts CI on a head that never got it. */
export async function sweepVersionPackages(host: FactoryHost, services: ShepherdServices, now: () => number = Date.now): Promise<ReleaseSweepNote[]> {
  const repos = [...new Set(services.store.get().all().map((registration) => registration.repo))];
  const notes: ReleaseSweepNote[] = [];
  for (const repo of repos) {
    const pr = await services.port.findPr(repo, VERSION_PACKAGES_BRANCH).catch(() => null);
    if (pr === null || pr.state !== "open") continue;
    const note = await sweepOne(host, services, repo, pr, now).catch((error: unknown) => ({ repo, pr: pr.number, error: error instanceof Error ? error.message : String(error) }));
    if (Object.keys(note).length > 2) notes.push(note);
  }
  return notes;
}

/** One repo's turn; a failure is that repo's note, so it never stops the sweep of the others. */
async function sweepOne(host: FactoryHost, services: ShepherdServices, repo: RepoSlug, pr: PullRequest, now: () => number): Promise<ReleaseSweepNote> {
  const registered = await registerOnce(host, services, repo, pr.number);
  const startedCi = await startCiIfIdle(services.port, repo, pr, now);
  return { repo, pr: pr.number, ...(registered && { registered }), ...(startedCi && { startedCi }) };
}

/** A live registration is left alone, so the sweep never refreshes it; a failed run is restarted by `register` itself. */
async function registerOnce(host: FactoryHost, services: ShepherdServices, repo: RepoSlug, pr: number): Promise<string | undefined> {
  const known = services.store.get().byPr(repo, pr);
  if (known && host.runtime.status(known.runId)?.status !== "failed") return undefined;
  return (await registerVersionPackages({ warnings: [], format: "json", host, shepherd: services }, repo, pr)).runId;
}

/**
 * Pushes one empty commit when the head has no Actions run and is older than the grace. An empty head is never pushed
 * onto again, so a repo whose Actions are down gets one commit, not one per sweep.
 */
export async function startCiIfIdle(port: GitHubPort, repo: RepoSlug, pr: PullRequest, now: () => number): Promise<string | undefined> {
  const runs = await port.checkRuns(repo, pr.headSha);
  if (runs.some((run) => run.headSha === pr.headSha && run.appId === GITHUB_ACTIONS_APP_ID)) return undefined;
  const head = await port.getCommit(repo, pr.headSha);
  if (head.committedAt === undefined || now() - Date.parse(head.committedAt) < START_CI_AFTER_MS) return undefined;
  const parent = head.parents.length === 1 ? await port.getCommit(repo, head.parents[0]!) : undefined;
  if (parent !== undefined && parent.tree === head.tree) return undefined;
  const pushed = await port.pushEmptyCommit(repo, VERSION_PACKAGES_BRANCH, pr.headSha, START_CI_MESSAGE);
  return pushed.done ? pushed.sha : undefined;
}
