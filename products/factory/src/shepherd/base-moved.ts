import type { PendingGate, FactoryHost } from "../host.js";
import { RESYNC_CONCURRENCY, RESYNC_READ_TIMEOUT_MS, mapBounded, readValue } from "./bounded.js";
import { approveMergeRun, type SupersededGate } from "./head-moved.js";
import { keptForOwner } from "./owner-kept.js";
import { runPolicyCeiling, stricterPolicy } from "./policy.js";
import type { ShepherdServices } from "./services.js";
import { SUPERSEDED, cancelUnlessSettled } from "./stale-gates.js";

/** The base land named when it asked; a gate from before land named its base reads as none and is left alone. */
const NAMED_BASE = / into (\S+)\? CI is green\./;

interface BaseGate {
  runId: string;
  gateId: string;
  named: string;
  featureBase: boolean;
}

interface StaleBase {
  live: string;
  reason: string;
}

/** One `defaultBranch` read per repo per pass; a failed read fails every gate of that repo this pass, so none is cancelled. */
type DefaultBranches = (repo: string) => Promise<string>;

function memoDefaultBranches(services: ShepherdServices): DefaultBranches {
  const reads = new Map<string, Promise<string>>();
  return (repo) => {
    const key = repo.toLowerCase();
    if (!reads.has(key)) reads.set(key, services.port.defaultBranch(repo));
    return reads.get(key)!;
  };
}

/** The run's policy as land narrows it before each decision: the run's own ceiling narrowed by its registration. */
function grantsFeatureBase(host: FactoryHost, services: ShepherdServices, runId: string): boolean {
  const run = host.runtime.status(runId);
  const registration = services.store.get().byRun(runId);
  if (!run || !registration) return false;
  return stricterPolicy(registration.policy, runPolicyCeiling(run.params.policy)).featureBase === true;
}

function baseGate(host: FactoryHost, services: ShepherdServices, pending: PendingGate): BaseGate[] {
  const named = approveMergeRun(host, pending) && NAMED_BASE.exec(pending.gate.prompt)?.[1];
  if (!named) return [];
  try {
    return [{ runId: pending.runId, gateId: pending.gate.id, named, featureBase: grantsFeatureBase(host, services, pending.runId) }];
  } catch {
    return [];
  }
}

/**
 * Why the gate's base no longer stands, read the way `movedHead` reads a head: a snapshot row still at the named base,
 * on a base the run may merge into, costs no PR read; anything else is confirmed through the port. Undefined while the
 * base stands, or the PR cannot be read or is no longer open.
 */
async function staleBase(services: ShepherdServices, defaults: DefaultBranches, { runId, named, featureBase }: BaseGate): Promise<StaleBase | undefined> {
  const registration = services.store.get().byRun(runId);
  if (!registration || registration.pr === null) return undefined;
  const { repo, pr: number } = registration;
  try {
    const row = (await services.snapshot?.openPrs(repo))?.find((pr) => pr.number === number);
    if (row?.baseRef === named && (featureBase || named === (await defaults(repo)))) return undefined;
    const pr = await services.port.getPr(repo, number);
    if (pr.state !== "open") return undefined;
    if (pr.baseRef !== named) return { live: pr.baseRef, reason: `the pull request's base moved from ${named} to ${pr.baseRef}` };
    const defaultBranch = await defaults(repo);
    return featureBase || pr.baseRef === defaultBranch ? undefined : { live: pr.baseRef, reason: `the base ${pr.baseRef} is not the default branch ${defaultBranch}` };
  } catch {
    return undefined;
  }
}

/**
 * Cancels each pending shepherd-pr approve-merge gate whose named base is no longer the PR's base, or whose base is not
 * the default branch on a run with no feature-base grant; the run then asks again against the live base, where land's
 * base check waits with no gate on a refused one. `dryRun` reports those gates and cancels none.
 */
export async function supersedeRebasedGates(host: FactoryHost, services: ShepherdServices, { dryRun = false } = {}): Promise<SupersededGate[]> {
  const asking = host.pendingGates().flatMap((pending) => baseGate(host, services, pending));
  const defaults = memoDefaultBranches(services);
  const stale = await mapBounded(asking, RESYNC_CONCURRENCY, (gate) => staleBase(services, defaults, gate), { timeoutMs: RESYNC_READ_TIMEOUT_MS });
  const superseded: SupersededGate[] = [];
  for (const [index, { runId, gateId, named }] of asking.entries()) {
    const base = readValue(stale[index]!);
    if (!base || host.gates.get(gateId)?.status !== "pending") continue;
    // The reads above yield, so an owner hold placed meanwhile is read again here, right before the cancel.
    if (keptForOwner(services.store.get().byRun(runId))) continue;
    if (!dryRun && !cancelUnlessSettled(host.gates, gateId, `${SUPERSEDED}${base.reason}`)) continue;
    superseded.push({ runId, gateId, from: named, to: base.live, condition: "base-changed" });
  }
  return superseded;
}
