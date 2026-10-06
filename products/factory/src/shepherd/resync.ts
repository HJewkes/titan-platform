import type { RepoSlug } from "@titan-design/github";
import type { FactoryHost, PendingGate } from "../host.js";
import type { ShepherdServices } from "./commands.js";
import { failureOf } from "./error-class.js";
import { frozenFor, recheckedFrozen } from "./freeze.js";
import { LIVE, endRunsGoneElsewhere, type EndedRun } from "./gone-elsewhere.js";
import { approveMergeRun, authorityGate, openHead, supersedeMovedGates, type SupersededGate } from "./head-moved.js";
import { FINISHED_RUN_STATUSES } from "./run-status.js";
import { REREVIEW } from "./stale-gates.js";

export const ORPHANED = "orphaned: the run already ended";

interface CancelError {
  runId: string;
  cause: string;
}

export interface ResyncReport {
  dryRun: boolean;
  /** Live shepherd-pr runs whose PR was merged or closed outside Shepherd. */
  ended: EndedRun[];
  /** Runs whose PR left Shepherd but whose lease a live holder still kept, or whose PR could not be read; `recheckHeld` settles them before adoption. */
  held: string[];
  /** Held runs the runtime refused to cancel for a reason other than a lease, with that reason. */
  cancelErrors: CancelError[];
  /** Pending gates whose run already completed, failed or was cancelled. */
  orphanGates: string[];
  /** Gates cancelled because their head moved or their MRG-AU gate failed only on transient conditions; each run starts a new cycle. */
  superseded: SupersededGate[];
  /** Why superseding moved gates failed; the rest of the report still stands. */
  supersedeError?: string;
}

/** A gate id is `<runId>/<step>`; a gate whose run is gone from the store is left alone. */
function orphanGates(host: FactoryHost): string[] {
  return host.gates.listPending().flatMap((gate) => {
    const runId = gate.id.slice(0, Math.max(0, gate.id.indexOf("/")));
    const status = runId ? host.runtime.status(runId)?.status : undefined;
    return status !== undefined && FINISHED_RUN_STATUSES.has(status) ? [gate.id] : [];
  });
}

/** Unmet conditions a fresh read can clear at the same head: a stale merge-tree read, and a freeze that has since thawed or that now exempts the PR as its fix. */
const TRANSIENT_CONDITIONS: readonly string[] = ["merge-tree-clean", "repo-not-frozen"];

const MRG_AU_UNMET = /^MRG-AU-[A-Z]+ unmet: (.+)$/;

/**
 * The transient conditions unmet on the MRG-AU allow rows whose every unmet condition is transient, so a fresh read may let
 * one hold; empty when each row also missed a lasting condition, such as a verdict at the head or a carry nobody made.
 */
export function transientOnlyConditions(reason: string): string[] {
  const unmet = reason.split("; ").flatMap((part) => {
    const conditions = MRG_AU_UNMET.exec(part)?.[1]?.split(", ") ?? [];
    return conditions.every((condition) => TRANSIENT_CONDITIONS.includes(condition)) ? conditions : [];
  });
  return TRANSIENT_CONDITIONS.filter((condition) => unmet.includes(condition));
}

interface TransientSweep {
  dryRun?: boolean;
  /** Only gates of runs on this repo, as a thaw sweeps; absent sweeps every repo. */
  repo?: RepoSlug;
}

/**
 * A freeze store that cannot be read counts as frozen, so its gates stay with the owner; the freeze's own fix PR never does.
 * Outside a dry run the PR's default branch is re-read as merge policy does, so a main fixed outside Shepherd thaws here too.
 */
async function stillFrozen(services: ShepherdServices, repo: RepoSlug, pr: number | null, dryRun: boolean): Promise<boolean> {
  try {
    const freezes = services.freeze?.get();
    if (!freezes) return false;
    if (pr === null) return freezes.isFrozen(repo);
    if (dryRun) return frozenFor(freezes, services.store.get(), repo, pr);
    return await recheckedFrozen(services.port, () => freezes, () => services.store.get())(repo, pr);
  } catch {
    return true;
  }
}

/** A pending MRG-AU approve-merge gate that failed only on transient conditions, on a PR the store no longer holds frozen. */
async function transientGate(host: FactoryHost, services: ShepherdServices, pending: PendingGate, { dryRun = false, repo: only }: TransientSweep): Promise<{ head: string; conditions: string[] } | undefined> {
  const run = approveMergeRun(host, pending);
  const gate = run && authorityGate(run, pending.gate.prompt);
  const conditions = gate ? transientOnlyConditions(gate.reason) : [];
  const registration = services.store.get().byRun(pending.runId);
  const repo = registration?.repo;
  if (!gate || conditions.length === 0 || !repo) return undefined;
  if (only !== undefined && repo.toLowerCase() !== only.toLowerCase()) return undefined;
  if (await stillFrozen(services, repo, registration.pr, dryRun)) return undefined;
  return { head: gate.head, conditions };
}

const onlyUnmet = (conditions: string[]): string =>
  conditions.length === 1 ? `${conditions[0]} was the only unmet condition` : `${conditions.join(" and ")} were the only unmet conditions`;

/**
 * Cancels each pending MRG-AU approve-merge gate still at the PR head whose only unmet conditions were transient, unless
 * its repo is frozen now for that PR, so the run asks the policy again at the same head. A freeze's own fix PR is not
 * frozen for itself, so its gate is superseded while the freeze it fixes still stands.
 */
export async function supersedeTransientGates(host: FactoryHost, services: ShepherdServices, { dryRun = false, repo }: TransientSweep = {}): Promise<SupersededGate[]> {
  const superseded: SupersededGate[] = [];
  for (const pending of host.pendingGates()) {
    const gate = await transientGate(host, services, pending, { dryRun, repo });
    if (!gate) continue;
    if ((await openHead(services, pending.runId)) !== gate.head || host.gates.get(pending.gate.id)?.status !== "pending") continue;
    if (!dryRun) host.gates.cancel(pending.gate.id, `${REREVIEW}${onlyUnmet(gate.conditions)} at head ${gate.head}`);
    const condition = gate.conditions.join() === "merge-tree-clean" ? "merge-tree-only" : "transient-only";
    superseded.push({ runId: pending.runId, gateId: pending.gate.id, from: gate.head, to: gate.head, condition });
  }
  return superseded;
}

/**
 * Brings Shepherd's runs and gates in line with GitHub after time away: ends live runs whose PR left Shepherd, cancels
 * the gates of runs that already ended, then supersedes gates whose open PR moved head and MRG-AU gates whose only unmet
 * conditions were transient, on a PR no longer frozen. A PR that cannot be read leaves its run alone. A gate is only ever cancelled, never
 * resolved: the run's new cycle asks again. `dryRun` computes the same report and writes nothing.
 */
export async function resyncShepherd(host: FactoryHost, services: ShepherdServices, { dryRun = false } = {}): Promise<ResyncReport> {
  const held: string[] = [];
  const cancelErrors: CancelError[] = [];
  const onCancelFailed = (runId: string, cause: string) => {
    held.push(runId);
    cancelErrors.push({ runId, cause });
  };
  const ended = await endRunsGoneElsewhere(host, services, { scope: "live", dryRun, onHeld: (runId) => held.push(runId), onUnreadable: (runId) => held.push(runId), onCancelFailed });
  const orphans = orphanGates(host);
  if (!dryRun) for (const gateId of orphans) host.gates.cancel(gateId, ORPHANED);
  const report: ResyncReport = { dryRun, ended, held, cancelErrors, orphanGates: orphans, superseded: [] };
  try {
    report.superseded = await supersedeMovedGates(host, services, { dryRun });
    report.superseded.push(...(await supersedeTransientGates(host, services, { dryRun })));
  } catch (err) {
    report.supersedeError = failureOf(err);
  }
  return report;
}

interface HeldRecheck {
  ended: EndedRun[];
  /** Held runs whose PR could not be read, with the read's error; adoption must leave them unclaimed this tick. */
  unreadable: Map<string, string>;
  /** Held runs whose PR left Shepherd but whose cancel failed for a reason other than a lease; adoption must leave them unclaimed too. */
  uncancelled: Map<string, string>;
}

/**
 * Runs right before adoption for the runs resync could not cancel: adoption would drive a run whose PR left Shepherd
 * toward sh-landed, so it is ended first. `held` keeps the runs still leased elsewhere, to be rechecked on the next tick;
 * a run whose PR cannot be read is neither ended nor safe to adopt, so it is reported `unreadable` and stays held, as is
 * one whose cancel failed, reported `uncancelled`.
 */
export async function recheckHeld(host: FactoryHost, services: ShepherdServices, held: Set<string>): Promise<HeldRecheck> {
  for (const runId of held) if (!LIVE.has(host.runtime.status(runId)?.status ?? "")) held.delete(runId);
  const unreadable = new Map<string, string>();
  const uncancelled = new Map<string, string>();
  if (held.size === 0) return { ended: [], unreadable, uncancelled };
  const onUnreadable = (runId: string, cause: string) => unreadable.set(runId, cause);
  const ended = await endRunsGoneElsewhere(host, services, { scope: "live", only: held, onUnreadable, onCancelFailed: (runId, cause) => uncancelled.set(runId, cause) });
  for (const { runId } of ended) held.delete(runId);
  return { ended, unreadable, uncancelled };
}
