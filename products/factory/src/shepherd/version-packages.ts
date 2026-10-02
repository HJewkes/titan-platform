import { GITHUB_ACTIONS_APP_ID, type GitHubPort, type PullRequest, type RepoSlug } from "@titan-design/github";
import type { FactoryHost } from "../host.js";
import { registerVersionPackages, type ShepherdServices } from "./commands.js";
import { VERSION_PACKAGES_BRANCH, blockedOnlyByNpm, npmRegistry, publishedSince, type PackageRegistry } from "./release.js";

/** How often `titan-factory serve` looks for a Version Packages PR in each shepherded repo. */
export const RELEASE_SWEEP_MS = 60_000;
/** A head this old with no Actions run never started CI, because the changesets action pushes with GITHUB_TOKEN. */
export const START_CI_AFTER_MS = 2 * 60_000;
export const START_CI_MESSAGE = "Start CI for the Version Packages PR\n\nShepherd pushed this empty commit: a push by the changesets action starts no workflow until the GitHub App (TP-447) pushes instead.";

export interface ReleaseSweepNote {
  repo: RepoSlug;
  pr: number;
  registered?: string;
  /** The owner gate cancelled because every package that blocked the release is on npm now. */
  unblocked?: string;
  startedCi?: string;
  error?: string;
}

/** Registers each open Version Packages PR in a shepherded repo once, and starts CI on a head that never got it. */
export async function sweepVersionPackages(host: FactoryHost, services: ShepherdServices, now: () => number = Date.now, registry: PackageRegistry = npmRegistry()): Promise<ReleaseSweepNote[]> {
  const repos = [...new Set(services.store.get().all().map((registration) => registration.repo))];
  const notes: ReleaseSweepNote[] = [];
  for (const repo of repos) {
    const pr = await services.port.findPr(repo, VERSION_PACKAGES_BRANCH).catch(() => null);
    if (pr === null || pr.state !== "open") continue;
    const note = await sweepOne(host, services, { repo, pr, now, registry }).catch((error: unknown) => ({ repo, pr: pr.number, error: error instanceof Error ? error.message : String(error) }));
    if (Object.keys(note).length > 2) notes.push(note);
  }
  return notes;
}

interface SweepTarget {
  repo: RepoSlug;
  pr: PullRequest;
  now: () => number;
  registry: PackageRegistry;
}

/** One repo's turn; a failure is that repo's note, so it never stops the sweep of the others. */
async function sweepOne(host: FactoryHost, services: ShepherdServices, { repo, pr, now, registry }: SweepTarget): Promise<ReleaseSweepNote> {
  const unblocked = await unblockPublished(host, services, registry, repo, pr.number);
  const registered = await registerOnce(host, services, repo, pr.number);
  const startedCi = await startCiIfIdle(services.port, repo, pr, now);
  return { repo, pr: pr.number, ...(unblocked && { unblocked }), ...(registered && { registered }), ...(startedCi && { startedCi }) };
}

/** The stored preflight is final for its run, so a gate that only a hand publish blocked is cancelled; the failed run is then restarted with a fresh read. */
async function unblockPublished(host: FactoryHost, services: ShepherdServices, registry: PackageRegistry, repo: RepoSlug, pr: number): Promise<string | undefined> {
  const known = services.store.get().byPr(repo, pr);
  const run = known && host.runtime.status(known.runId);
  const pending = run && host.pendingGates().find((gate) => gate.runId === run.id && gate.stepId === "approve-merge");
  const preflight = pending && blockedOnlyByNpm(run.stepResults, pending.gate.prompt);
  if (!preflight || !(await publishedSince(registry, preflight))) return undefined;
  host.gates.cancel(pending.gate.id, `${preflight.unpublished.join(", ")} is on registry.npmjs.org now; a new run reads the release again`);
  await host.runtime.wait(run.id);
  return pending.gate.id;
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
