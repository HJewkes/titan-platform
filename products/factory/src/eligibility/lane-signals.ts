import type { Verbs } from "../cli-types.js";
import { checkedDeploy } from "../cli-shepherd.js";
import { configPath, loadConfig } from "../config.js";
import { deployBlockOf, type DeployHealth } from "../deploy-health.js";
import { EXIT } from "../exit-codes.js";
import type { FactoryHost, FactoryRoutes } from "../host.js";
import { errorMessage } from "../narrow.js";
import { ownerQueueSources } from "../needs/command.js";
import { collectNeeds } from "../needs/merged.js";
import { probeServe } from "../serve-probe.js";
import { FACTORY_PORT } from "../serve.js";
import { DEFAULT_ACCOUNT } from "../shepherd/account-limit.js";
import { AccountLimitStore } from "../shepherd/account-store.js";
import { FreezeStore } from "../shepherd/freeze.js";
import { FINISHED_PHASES } from "../shepherd/step-phase.js";
import { runFinished, watchRows } from "../shepherd/watch-rows.js";
import type { LaneSignals, SignalName } from "./back-pressure.js";

/** Which Shepherd registrations belong to the lane, by their `initiative/ID` task key. */
export interface LaneScope {
  inLane: (taskKey: string) => boolean;
}

export type LaneSignalRead = (scope: LaneScope) => Promise<LaneSignals>;

type Unread = Partial<Record<SignalName, string>>;

/** A merge within this many minutes of the oldest commit the running build lacks counts as not deployed; covers the whole-minute rounding. */
const ROUNDING_SLACK_MIN = 1;

/** serve's `/health` deploy block, with git's reading of origin/main past the running build, exactly as `shepherd status` reads it. */
async function readDeploy(verbs: Verbs): Promise<DeployHealth> {
  const probe = await probeServe(FACTORY_PORT, verbs.deps.serveWaitMs);
  if (probe.state !== "up") throw new Error(`titan-factory serve did not answer /health (${probe.state})`);
  const block = await checkedDeploy(verbs, deployBlockOf(probe.health));
  if (block === null) throw new Error("serve's /health keeps no deploy block");
  return block;
}

/** The instant before which every lane merge is in the running build; undefined when nothing waits to deploy. */
const deployCutoff = (deploy: DeployHealth, now: number): number | undefined => (deploy.behind > 0 ? now - (deploy.behindMinutes + ROUNDING_SLACK_MIN) * 60_000 : undefined);

/** Lane PRs from Shepherd's watch rows: only lane runs still going, or finished since the cutoff, are loaded. */
async function prCounts(host: FactoryHost, routes: FactoryRoutes, scope: LaneScope, cutoff: number | undefined): Promise<Pick<LaneSignals, "openPrs" | "mergedNotDeployed">> {
  if (!routes.shepherd) throw new Error("this host was opened without the shepherd routes");
  const since = cutoff === undefined ? undefined : new Date(cutoff).toISOString();
  const rows = await watchRows(host, routes.shepherd, (registration, status) => scope.inLane(registration.task) && (!runFinished(status) || (since !== undefined && registration.updatedAt >= since)));
  const merged = rows.filter((row) => row.outcome?.kind === "merged" && cutoff !== undefined && Date.parse(row.phaseSince) >= cutoff);
  return { openPrs: rows.filter((row) => !FINISHED_PHASES.has(row.phase)).length, mergedNotDeployed: merged.length };
}

/** Every configured reviewer account, and how many the account-limit store holds exhausted now. */
function reviewerCounts(host: FactoryHost, env: NodeJS.ProcessEnv): NonNullable<LaneSignals["reviewers"]> {
  const review = loadConfig(configPath(env)).shepherd?.review;
  const dirs = [...new Set([review?.configDir ?? DEFAULT_ACCOUNT, ...(review?.fallbackConfigDirs ?? [])])];
  const store = new AccountLimitStore(host.db);
  return { accounts: dirs.length, exhausted: dirs.filter((dir) => store.exhausted(dir) !== undefined).length };
}

/** The merged owner queue `titan-factory needs` reads; any source it could not read makes the count unread. */
async function ownerQueueCount(host: FactoryHost, env: NodeJS.ProcessEnv): Promise<number> {
  const list = await collectNeeds(ownerQueueSources(env, host.gates));
  if (list.gaps.length > 0) throw new Error(`${list.gaps.length} owner-queue source(s) unread`);
  return list.items.length;
}

async function attempt<T>(unread: Unread, names: readonly SignalName[], read: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    for (const name of names) unread[name] ??= errorMessage(error);
    return undefined;
  }
}

type HostSignals = Pick<LaneSignals, "openPrs" | "mergedNotDeployed" | "ownerQueue" | "reviewers" | "redMain">;

/** Without the deploy reading no merge can be judged deployed, so the merged count is left unread with it. */
async function readHost(verbs: Verbs, host: FactoryHost, routes: FactoryRoutes, scope: LaneScope, deploy: DeployHealth | undefined, unread: Unread): Promise<HostSignals> {
  const cutoff = deploy && deployCutoff(deploy, Date.now());
  const prs = await attempt(unread, ["openPrs"], () => prCounts(host, routes, scope, cutoff));
  const reviewers = await attempt(unread, ["reviewers"], () => reviewerCounts(host, verbs.io.env));
  const ownerQueue = await attempt(unread, ["ownerQueue"], () => ownerQueueCount(host, verbs.io.env));
  const redMain = await attempt(unread, ["redMain"], () => new FreezeStore(host.db).activeFreezes().map((freeze) => freeze.repo));
  return {
    ...(prs?.openPrs !== undefined && { openPrs: prs.openPrs }),
    ...(prs?.mergedNotDeployed !== undefined && deploy !== undefined && { mergedNotDeployed: prs.mergedNotDeployed }),
    ...(reviewers && { reviewers }),
    ...(ownerQueue !== undefined && { ownerQueue }),
    ...(redMain && { redMain }),
  };
}

async function hostSignals(verbs: Verbs, scope: LaneScope, deploy: DeployHealth | undefined, unread: Unread): Promise<HostSignals> {
  let read: HostSignals = {};
  await attempt(unread, ["openPrs", "ownerQueue", "reviewers", "redMain"], () =>
    verbs.withHost(async (host, routes) => {
      read = await readHost(verbs, host, routes, scope, deploy, unread);
      return EXIT.OK;
    }),
  );
  return read;
}

/** Reads each signal from the factory's own stores and serve's `/health`; reads only. */
export function liveLaneSignals(verbs: Verbs): LaneSignalRead {
  return async (scope) => {
    const unread: Unread = {};
    const deploy = await attempt(unread, ["deploy"], () => readDeploy(verbs));
    const host = await hostSignals(verbs, scope, deploy, unread);
    return { ...host, ...(deploy && { deployStall: deploy.alarm ? deploy.causes : [] }), unread };
  };
}
