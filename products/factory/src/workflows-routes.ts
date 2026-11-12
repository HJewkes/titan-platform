import type { Db, Migration } from "@titan-design/store-sqlite";
import { systemAuditPorts } from "./audit/production.js";
import { auditRoutes } from "./audit/routes.js";
import { ownCheckout } from "./cli-service.js";
import { current } from "./config-ref.js";
import { withMergeWake } from "./merge-wake.js";
import { successorAccounts, withHoldAdversary } from "./workflows-live.js";
import type { DatabaseTenant, FactoryRoutes } from "./host.js";
import { hostCarryPorts } from "./shepherd/carry-cache-adapter.js";
import { inheritedRedCheck } from "./shepherd/inherited-red.js";
import { freezeCancelOnlyMigration, freezeFixPrMigration, freezeGuard, freezeMigration, freezeStoreRef, recheckedFrozen } from "./shepherd/freeze.js";
import { carry } from "./shepherd/tree-carry.js";
import { adversaryGuard } from "./shepherd/adversary-guard.js";
import { firstReason, heldCheck, holdSatisfier, holdingPort, openHeadRead, waitWhileHeld, type HoldSatisfier } from "./shepherd/hold.js";
import { releaseGuard } from "./shepherd/release.js";
import { retryingGhServerErrors } from "./shepherd/gh-retry.js";
import { mergeOrderGuard } from "./shepherd/merge-order-guard.js";
import { orderExpiryRoute } from "./shepherd/merge-order-expiry.js";
import { mergeOrderRoutes } from "./shepherd/merge-order-steps.js";
import { fileRules, mergeOrderMigration, mergeOrderRef, type OrderWaits } from "./shepherd/merge-order.js";
import { watchListMigration } from "./shepherd/watch-list.js";
import { gateEvidenceMigration } from "./shepherd/lan-gates.js";
import { mergeBaseExceptionMigration } from "./shepherd/merge-base-exception.js";
import { shepherdRoutes } from "./shepherd/pr.js";
import { redeployRoute } from "./shepherd/redeploy.js";
import { seatBaselineCheck, type SeatBook } from "./shepherd/seats.js";
import { advisoryGuard, advisoryPort, advisoryUpdates } from "./shepherd/advisory.js";
import { accountLimitMigration, accountLimitStoreRef } from "./shepherd/account-store.js";
import { proofWaiverMigration } from "./shepherd/proof-waiver-table.js";
import { planApprovalMigration } from "./shepherd/plan-approval.js";
import { repoFreezeMigration } from "./shepherd/repo-freeze.js";
import { holdReviewerMigration, holdSatisfiedMigration, holdSlotsMigration, lastSliceMigration, lineageMigration, ownerHoldMigration, parkSettledMigration, registrantMigration, registrationFactsMigration, repairStopMigration, reviewRequestMigration, shepherdMigration, sliceMigration } from "./shepherd/store.js";
import { gateCancelKindMigration, orderEventKindsMigration, orderWaitKindMigration, reclassMarkMigration, shepherdEventMigration } from "./shepherd/events.js";
import { reviewPendingAt } from "./shepherd/review-request.js";
import { g10Recheck } from "./shepherd/g10-release.js";
import { leaveTrainToWait, mergeTrainRef, rideTrain, trainLeaveRoute, trainMigration } from "./shepherd/train.js";
import { shadowRefresh, trainShadowMigration, trainShadowRef } from "./shepherd/train-shadow.js";
import { shadowHeldCheck } from "./shepherd/train-shadow-held.js";
import { sleep } from "./workflows/land.js";
import { landPrRoutes } from "./workflows/land-pr.js";
import { hostPostMerge, type PostMergeHost } from "./workflows/post-merge-adapter.js";
import { buildSurfaceRoutes, factoryBuildPorts } from "./build-surface/index.js";
import { portReads } from "./workflows/pr-snapshot.js";
import type { ShepherdServices } from "./shepherd/services.js";
import type { FactoryRouteDeps } from "./workflows-deps.js";

const NO_SEATS: SeatBook = { seats: [], denied: [] };

/** The shepherd tenant's versions follow the host's 1-3; the host's own later migrations take numbers above these. */
export const SHEPHERD_MIGRATIONS: readonly Migration[] = [shepherdMigration(4), lineageMigration(5), freezeMigration(6), sliceMigration(8), holdReviewerMigration(9), trainMigration(10), holdSatisfiedMigration(11), freezeCancelOnlyMigration(12), shepherdEventMigration(16), accountLimitMigration(17), reviewRequestMigration(18), holdSlotsMigration(19), parkSettledMigration(21), ownerHoldMigration(22), freezeFixPrMigration(23), registrationFactsMigration(24), reclassMarkMigration(25), trainShadowMigration(26), repairStopMigration(31), proofWaiverMigration(32), repoFreezeMigration(33), registrantMigration(38), gateCancelKindMigration(39), mergeOrderMigration(40), watchListMigration(41), mergeBaseExceptionMigration(42), lastSliceMigration(43), orderEventKindsMigration(44), orderWaitKindMigration(45), planApprovalMigration(46), gateEvidenceMigration(48)];

/**
 * Routes for every dispatch step of `factoryWorkflows`, each match once. Every merge goes through the hold, so a held
 * PR never reaches the port's merge, whichever workflow lands it; an unbound store refuses the merge. A shepherd-pr
 * merge then waits for its repo's train, so a held PR never holds the train while it waits, and a run gives the train
 * up before it waits on a retarget. An advisory repo's merge and update wait held, and its port refuses every write
 * to a branch, whichever route reaches it.
 */
export function factoryRoutesFor(given: FactoryRouteDeps): FactoryRoutes {
  const isAdvisory = given.advisory ?? (() => false);
  const deps = { ...given, port: advisoryPort(given.port, isAdvisory), gitCache: given.gitCache ?? hostCarryPorts, ...withHost(given) };
  const holds = () => deps.store.get();
  const pause = deps.sleep ?? sleep;
  const freeze = deps.freeze ?? freezeStoreRef(deps.now);
  const order = mergeOrderRef();
  const orderRules = deps.mergeOrderRules ?? fileRules;
  const orderWaits: OrderWaits = new Map();
  const ordered = mergeOrderGuard({ order: () => order.get(), registrations: holds, rules: orderRules, now: deps.now, waits: orderWaits });
  const adversary = adversaryGuard({ store: holds, carry: (input) => carry(input, { ports: hostCarryPorts, ...deps.review?.carry }) });
  const guard = firstReason(advisoryGuard(isAdvisory), freezeGuard({ freezes: () => freeze.get(), registrations: holds, now: deps.now }), releaseGuard(holds, deps.now), adversary, ordered);
  const satisfy = holdSatisfierFor(deps);
  const held = heldCheck(deps.port, holds, guard, satisfy, deps.snapshot);
  const train = deps.train ?? mergeTrainRef(deps.now);
  const accountLimits = deps.accountLimits ?? accountLimitStoreRef(deps.now);
  const timing = { sleep: pause, pollMs: deps.holdPollMs, now: deps.now };
  const shadow = { shadow: trainShadowRef(), port: deps.port, reads: deps.snapshot ?? portReads(deps.port), held: shadowHeldCheck({ port: deps.port, holds, freezes: () => freeze.get(), advisory: isAdvisory, now: deps.now, snapshot: deps.snapshot }), advisory: isAdvisory, now: deps.now };
  const shepherdDeps = { port: deps.port, gitCache: deps.gitCache, advisory: isAdvisory, store: deps.store, now: deps.now, sleep: pause, pollMs: deps.pollMs, agentChatBin: deps.agentChatBin ?? "agent-chat", agentChatConfigDir: deps.agentChatConfigDir, successorAccounts: successorAccounts(deps.agentChatConfigDir, deps.review?.accounts), roster: deps.roster, spawnGate: deps.spawnGate, cleanup: deps.cleanup, snapshot: deps.snapshot, pushes: deps.pushes, reviewCheck: deps.reviewCheck, exitNotice: deps.exitNotice, suiteRules: deps.suiteRules, accountLimits, prFiles: deps.prFiles, stackRestack: deps.stackRestack, get heldRepair() { return current(deps.heldRepair); }, get lowTierPolicy() { return current(deps.lowTierPolicy); }, get ownerTier() { return current(deps.ownerTier); }, get noReproProceed() { return current(deps.noReproProceed); }, get nonSourceNoRepro() { return current(deps.nonSourceNoRepro); }, get taskClose() { return current(deps.taskClose); }, visualPacket: deps.visualPacket, diagnosis: deps.diagnosis, replan: deps.replan, consoleAnswers: deps.consoleAnswers, visualBaselineCheck: (repo: string) => seatBaselineCheck(deps.seats?.() ?? NO_SEATS, repo) };
  const land = landPrRoutes({ ...deps, port: holdingPort(deps.port, holds, guard, satisfy), inheritedRed: inheritedRedCheck(shepherdDeps, () => freeze.get()) }).map((route) => {
    if (route.match === "base-wait") return leaveTrainToWait(route, train);
    if (route.match === "update-branch") return shadowRefresh(advisoryUpdates(route, isAdvisory, timing), shadow);
    return route.match === "merge" ? waitWhileHeld(rideTrain(route, { train, port: deps.port, held, timing, now: deps.now }), held, timing, openHeadRead(deps.port, deps.snapshot), (repo, pr, sha) => reviewPendingAt(holds().byPr(repo, pr), sha), adversary.takeRehold, g10Recheck(holds)) : route;
  });
  const review = deps.review && withHoldAdversary({ ...deps.review, isFrozen: deps.isFrozen ?? recheckedFrozen(deps.port, () => freeze.get(), holds, deps.now) }, deps.review);
  const shepherd = shepherdRoutes(shepherdDeps, { review, park: deps.park, registry: deps.registry, versions: deps.versions, mainRed: { ...deps.mainRed, freezes: () => freeze.get() } });
  const database: DatabaseTenant = { extraMigrations: SHEPHERD_MIGRATIONS, bind: (db) => bindAll(db, deps.store, freeze, train, accountLimits, shadow.shadow, order) };
  const services: ShepherdServices = { store: deps.store, port: deps.port, seats: deps.seats ?? (() => NO_SEATS), train, freeze, snapshot: deps.snapshot, pacing: deps.pacing, now: shepherdDeps.now, prFiles: deps.prFiles, gateway: deps.gateway, ...(deps.spawnGate && { reviewSlots: deps.spawnGate.reviewSlots }), ...(deps.visualDelivery && { visualDelivery: deps.visualDelivery }), ...(deps.thawAlert && { thawAlert: deps.thawAlert }), mergeOrder: { order: () => order.get(), holds, rules: orderRules, waits: orderWaits, now: shepherdDeps.now }, ...(deps.roster && { roster: deps.roster }), ...(deps.exitNotice?.hubSeat && { hubSeat: deps.exitNotice.hubSeat }), visualThreshold: deps.visualThreshold ?? deps.review?.visualThreshold, lowTierPolicy: () => current(deps.lowTierPolicy) };
  return Object.assign([...retryingGhServerErrors([...land, ...withMergeWake(shepherd, deps.mergeWake)], { sleep: pause, now: shepherdDeps.now }), trainLeaveRoute(train, shepherdDeps.now), ...mergeOrderRoutes({ order: () => order.get(), holds, rules: orderRules, port: deps.port, train, timing, now: shepherdDeps.now }), orderExpiryRoute({ order: () => order.get(), rules: orderRules, now: shepherdDeps.now }), redeployRoute(shepherdDeps.now, deps.redeploy), ...auditRoutes(deps.audit ?? systemAuditPorts(ownCheckout())), ...buildSurfaceRoutes(factoryBuildPorts({ ...deps, agentChatBin: shepherdDeps.agentChatBin }))], { database, shepherd: services });
}

/** The caller's clock, environment and chore runner, or the live host's for any it leaves out. */
function withHost(given: FactoryRouteDeps): PostMergeHost {
  const host = hostPostMerge();
  return { now: given.now ?? host.now, env: given.env ?? host.env, runChore: given.runChore ?? host.runChore };
}

/** A hold's named reviewer is read through the review wiring's roster and reader; with no dispatch wired no hold is ever satisfied. */
function holdSatisfierFor(deps: FactoryRouteDeps): HoldSatisfier | undefined {
  const dispatch = deps.review?.dispatch;
  if (!deps.review || !dispatch) return undefined;
  const { lineage, reader } = deps.review;
  return holdSatisfier({ store: () => deps.store.get(), roster: () => dispatch.roster(), lineage, reader, carry: (input) => carry(input, { ports: hostCarryPorts, ...deps.review?.carry }) });
}

/** All or none: a bind that throws unbinds the refs bound before it, so no store stays bound to a database the host never opened. */
export function bindAll(db: Db, ...refs: { bind(db: Db): () => void }[]): () => void {
  const unbinds: (() => void)[] = [];
  try {
    for (const ref of refs) unbinds.push(ref.bind(db));
  } catch (error) {
    unbinds.reverse().forEach((unbind) => unbind());
    throw error;
  }
  return () => unbinds.forEach((unbind) => unbind());
}
