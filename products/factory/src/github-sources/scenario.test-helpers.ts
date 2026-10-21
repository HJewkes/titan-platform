import type { BackstopCommit, BackstopSnapshot, RulesetList } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { appendEvent } from "../event-log/event-log.js";
import { pullRequestDelivery, pushDelivery, reviewDelivery, rulesetDelivery, type PrFact } from "../event-log/repo-shapes.test-helpers.js";
import { projectDelivery } from "../ingress/kinds.js";
import { REPO, rig } from "../reconciler/fakes.test-helpers.js";
import { createObserve } from "../reconciler/observe.js";
import { createReconciler } from "../reconciler/service.js";
import { checkRunDelivery, statusDelivery, type CiFact } from "../test-support/a17/ci-shapes.js";

/** TP-3099 plan §3, I3: one synthetic repo where every GitHub kind happens once, written as facts both sources render. */
const HEAD = "a".repeat(40);
const MERGE = "c".repeat(40);
const TIP = "d".repeat(40);
const OLD = "f".repeat(40);
const AT = "2027-01-15T07:00:00Z";

const prCheck: CiFact = { type: "check", repo: REPO, head: HEAD, context: "build", checkRunId: 101, outcome: "success", at: AT };
const prStatus: CiFact = { type: "status", repo: REPO, head: HEAD, context: "ci/lint", outcome: "failure", at: AT };
const mainCheck: CiFact = { type: "check", repo: REPO, head: TIP, context: "build", checkRunId: 201, outcome: "success", at: AT };
const open: PrFact = { repo: REPO, pr: 7, head: HEAD, base: "main" };
const merged: PrFact = { repo: REPO, pr: 8, head: HEAD, base: "main", end: { merged: true, mergeSha: MERGE, closedAt: AT, mergedBy: "synthetic-merger" } };
const closed: PrFact = { repo: REPO, pr: 9, head: HEAD, base: "main", end: { merged: false, mergeSha: null, closedAt: AT } };

/** What the ingress receives for the scenario, in GitHub's webhook shapes. */
export const SCENARIO_DELIVERIES: readonly [event: string, payload: unknown][] = [
  ["check_run", checkRunDelivery(prCheck)],
  ["check_run", checkRunDelivery(mainCheck)],
  ["status", statusDelivery(prStatus)],
  ["pull_request", pullRequestDelivery(open, "opened")],
  ["pull_request", { ...pullRequestDelivery(open, "edited"), changes: { base: { ref: { from: "dev" } } } }],
  ["pull_request_review", reviewDelivery(open, 5, "submitted")],
  ["pull_request_review", reviewDelivery(open, 6, "dismissed")],
  ["pull_request", pullRequestDelivery(merged)],
  ["pull_request", pullRequestDelivery(closed)],
  ["push", pushDelivery(REPO, "main", TIP)],
  ["repository_ruleset", rulesetDelivery(REPO, 9, AT)],
];

const checkOf = (fact: CiFact) => ({ kind: "check", databaseId: fact.checkRunId ?? 0, name: fact.context, status: "COMPLETED", conclusion: fact.outcome.toUpperCase(), completedAt: AT }) as const;
const statusOf = (fact: CiFact) => ({ kind: "status", context: fact.context, state: fact.outcome.toUpperCase(), createdAt: AT }) as const;
const rateLimit = { cost: 1, remaining: 4999, resetAt: "2027-01-15T09:00:00Z", queries: 1 };

/** What the reconciler's snapshot read answers for the scenario. */
export function scenarioSnapshot(): BackstopSnapshot {
  const head: BackstopCommit = { oid: HEAD, contexts: [checkOf(prCheck), statusOf(prStatus)] };
  const reviews = [
    { databaseId: 5, state: "APPROVED", submittedAt: AT },
    { databaseId: 6, state: "DISMISSED", submittedAt: AT },
  ];
  return {
    open: [{ number: 7, headRefOid: HEAD, baseRefName: "main", updatedAt: AT, head, reviews }],
    done: [
      { number: 8, merged: true, mergedBy: "synthetic-merger", mergeCommit: MERGE, closedAt: AT, updatedAt: "2027-01-15T07:10:00Z" },
      { number: 9, merged: false, mergedBy: null, mergeCommit: null, closedAt: AT, updatedAt: "2027-01-15T07:20:00Z" },
    ],
    main: { tip: TIP, commits: [{ oid: TIP, contexts: [checkOf(mainCheck)] }] },
    rateLimit,
  };
}

/** The repo before the scenario: an older main and nothing else. */
export function priorSnapshot(): BackstopSnapshot {
  return { open: [], done: [], main: { tip: OLD, commits: [{ oid: OLD, contexts: [checkOf({ ...mainCheck, head: OLD, checkRunId: 301 })] }] }, rateLimit };
}

const rulesetList = (rulesets: Record<number, string>): RulesetList => ({ notModified: false, unreadable: false, rulesets, etag: '"r1"' });
export const SCENARIO_RULESETS = rulesetList({ 9: AT });
export const PRIOR_RULESETS = rulesetList({});

/** The answer core's append, with no socket and no signature: each delivery as the ingress stores it. */
export function deliver(db: Db, deliveries: readonly (readonly [string, unknown])[]): void {
  deliveries.forEach(([event, payload], index) => {
    const projected = projectDelivery(event, payload);
    if (projected === "ignored") throw new Error(`scenario delivery ${event} was ignored`);
    appendEvent(db, { ...projected, source: "webhook", deliveryId: `webhook:synthetic-${index}`, observedAt: AT });
  });
}

/**
 * The real reconciler and its real observe over the reconciler rig's pool, answering whatever `state` holds. TP-3431 builds
 * the production observe port; this one closes over the ruleset read, which the service does not thread yet.
 */
export function scenarioReconciler(state: { snapshot: BackstopSnapshot; rulesets: RulesetList }) {
  const observe = createObserve({ guard: { confirmHead: () => ({ kind: "confirmed" }), confirmTip: () => ({ kind: "confirmed" }) }, now: () => Date.parse("2027-01-15T08:00:00Z") });
  const r = rig({ observe: (repo, snapshot, cursor) => observe(repo, snapshot, cursor, state.rulesets) });
  r.github.snapshot = () => state.snapshot;
  return { ...r, service: createReconciler({ repos: [REPO], fullEvery: 3 }, r.deps) };
}

export const loggedKinds = (db: Db): Set<string> => new Set(db.prepare<[], { kind: string }>("SELECT kind FROM factory_event").all().map((row) => row.kind));
