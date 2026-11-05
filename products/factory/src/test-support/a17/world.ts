import type { BackstopDonePr, BackstopReview, BackstopSnapshot } from "@titan-design/github";
import { checkRunDelivery, rollupContext, statusDelivery, type CiFact } from "./ci-shapes.js";
import { FACT_KINDS, repoDelivery, type RepoFact } from "./repo-shapes.js";

/** Anything a case can make GitHub show. */
export type GithubFact = CiFact | RepoFact;

interface OpenPr {
  head: string;
  base: string;
  reviews: BackstopReview[];
  /** The latest CI fact on the head; a push to the PR clears it, as a new head starts with no checks. */
  ci?: CiFact;
}

interface RepoState {
  open: Map<number, OpenPr>;
  done: BackstopDonePr[];
  tip?: string;
  /** Ruleset id to its `updated_at`, as GitHub's list read answers it. */
  rulesets: Record<number, string>;
}

/** GitHub's state per repo, as the backstop's snapshot read answers it and as each fact's delivery describes it. */
export interface World {
  /** The delivery GitHub sends for the fact, read before the fact applies, since a `closed` delivery repeats the PR. */
  delivery(fact: GithubFact): { event: string; body: unknown };
  apply(fact: GithubFact): void;
  snapshot(repo: string): BackstopSnapshot;
  tip(repo: string): string | undefined;
  rulesets(repo: string): Record<number, string>;
  /** The head of an open PR. */
  head(repo: string, pr: number): string | undefined;
}

/** A CI fact with no open PR on its head lands on PR #1, which then shows that head. */
const CI_PR = 1;
const UPDATED_AT = "2026-10-17T10:00:00Z";
const RATE_LIMIT = { cost: 1, remaining: 4999, resetAt: "2026-10-17T13:00:00Z", queries: 1 };

const isCi = (fact: GithubFact): fact is CiFact => fact.type === "check" || fact.type === "status";

export const kindsOf = (fact: GithubFact): readonly string[] => FACT_KINDS[isCi(fact) ? "ci" : fact.type];

/** The subject the fact's rows carry. */
export function subjectOf(fact: GithubFact): string {
  if (isCi(fact)) return `${fact.repo}@${fact.head}`;
  if (fact.type === "push") return `${fact.repo}:main`;
  if (fact.type === "ruleset") return fact.repo;
  return `${fact.repo}#${fact.pr}`;
}

function applyCi(state: RepoState, fact: CiFact): void {
  const onHead = [...state.open.values()].find((pr) => pr.head === fact.head);
  if (onHead !== undefined) return void (onHead.ci = fact);
  const pr = state.open.get(CI_PR);
  state.open.set(CI_PR, { head: fact.head, base: pr?.base ?? "main", reviews: pr?.reviews ?? [], ci: fact });
}

function openPr(state: RepoState, fact: { repo: string; pr: number }): OpenPr {
  const pr = state.open.get(fact.pr);
  if (pr === undefined) throw new Error(`${fact.repo}#${fact.pr} is not open`);
  return pr;
}

function applyReview(pr: OpenPr, fact: Extract<RepoFact, { type: "review" }>): void {
  const review = { databaseId: fact.id, state: fact.action === "dismissed" ? "DISMISSED" : "APPROVED", submittedAt: UPDATED_AT };
  pr.reviews = [...pr.reviews.filter((r) => r.databaseId !== fact.id), review];
}

/** The GraphQL done node carries a fraction on its stamps that the webhook's omit. */
function applyEnded(state: RepoState, fact: Extract<RepoFact, { type: "ended" }>): void {
  openPr(state, fact);
  state.open.delete(fact.pr);
  const closedAt = fact.closedAt.replace("Z", ".000Z");
  state.done.push({ number: fact.pr, merged: fact.merged, mergedBy: fact.mergedBy ?? null, mergeCommit: fact.mergeSha, closedAt, updatedAt: closedAt });
}

/** A ruleset changes nothing the snapshot read returns: S2's ruleset read, in the gates, is the reconciler's only view of one. */
function applyFact(state: RepoState, fact: GithubFact): void {
  if (isCi(fact)) return applyCi(state, fact);
  if (fact.type === "pr") {
    const pr = state.open.get(fact.pr);
    state.open.set(fact.pr, { head: fact.head, base: fact.base, reviews: pr?.reviews ?? [], ...(pr?.head === fact.head && pr.ci !== undefined && { ci: pr.ci }) });
  } else if (fact.type === "review") applyReview(openPr(state, fact), fact);
  else if (fact.type === "ended") applyEnded(state, fact);
  else if (fact.type === "push") state.tip = fact.sha;
  else state.rulesets[fact.id] = fact.updatedAt;
}

function snapshotOf(state: RepoState | undefined): BackstopSnapshot {
  const open = [...(state?.open ?? [])].map(([number, pr]) => ({
    number,
    headRefOid: pr.head,
    baseRefName: pr.base,
    updatedAt: pr.ci?.at ?? UPDATED_AT,
    head: { oid: pr.head, contexts: pr.ci === undefined ? [] : [rollupContext(pr.ci)] },
    reviews: pr.reviews,
  }));
  return { open, done: state?.done ?? [], main: { tip: state?.tip ?? "0".repeat(40), commits: [] }, trains: [], rateLimit: RATE_LIMIT };
}

export function githubWorld(): World {
  const repos = new Map<string, RepoState>();
  const stateOf = (repo: string): RepoState => repos.get(repo) ?? repos.set(repo, { open: new Map(), done: [], rulesets: {} }).get(repo)!;
  return {
    delivery: (fact) => {
      if (isCi(fact)) return fact.type === "check" ? { event: "check_run", body: checkRunDelivery(fact) } : { event: "status", body: statusDelivery(fact) };
      return repoDelivery(fact, fact.type === "ended" || fact.type === "pr" ? stateOf(fact.repo).open.get(fact.pr) : undefined);
    },
    apply: (fact) => applyFact(stateOf(fact.repo), fact),
    snapshot: (repo) => snapshotOf(repos.get(repo)),
    tip: (repo) => repos.get(repo)?.tip,
    rulesets: (repo) => ({ ...repos.get(repo)?.rulesets }),
    head: (repo, pr) => repos.get(repo)?.open.get(pr)?.head,
  };
}
