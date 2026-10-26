import { z } from "zod";
import { utcSeconds, type Transport } from "./ci-keys.js";
import type { IdentityEvent, TransitionEvent } from "./event-log.js";

/** GitHub gives each of these its own identity: a merge sha, a close stamp, a review id, a ruleset stamp. */
interface IdentityObservation {
  rule: "identity";
  kind: "PRMerged" | "PRClosed" | "ReviewSubmitted" | "ReviewDismissed" | "RulesChanged";
  /** Lowercased `owner/name`. */
  repo: string;
  subject: string;
  /** The occurrence key's fields after the `v1|<kind>|<repo>|` prefix, in order. */
  fields: (string | number)[];
  keys: Record<string, unknown>;
}

/** GitHub gives only a current value, so the log's transition rule decides whether it moved. */
interface TransitionObservation {
  rule: "transition";
  kind: "HeadPushed" | "BaseChanged" | "MainMoved";
  repo: string;
  /** `repo#pr` for head and base, `repo:branch` for main. */
  subject: string;
  value: string;
}

export type RepoObservation = IdentityObservation | TransitionObservation;

/** Builds the occurrence key; injectable so a test can swap in a narrower contract. */
type RepoKeyFn = (observation: IdentityObservation) => string;

export const repoKey: RepoKeyFn = (o) => `v1|${o.kind}|${o.repo}|${o.fields.join("|")}`;

const prSubject = (repo: string, pr: number): string => `${repo}#${pr}`;

const transition = (kind: TransitionObservation["kind"], repo: string, subject: string, value: string): TransitionObservation => ({ rule: "transition", kind, repo, subject, value });

const prTransitions = (repo: string, pr: number, head: string, base: string): TransitionObservation[] => [
  transition("HeadPushed", repo, prSubject(repo, pr), head),
  transition("BaseChanged", repo, prSubject(repo, pr), base),
];

interface Ending {
  merged: boolean;
  mergeSha: string | null;
  closedAt: string | null;
  mergedBy: string | null;
}

/** A merged PR is a PRMerged and nothing else; a merge whose sha is not yet readable is no occurrence. */
function ending(repo: string, pr: number, end: Ending): IdentityObservation[] {
  const base = { rule: "identity", repo, subject: prSubject(repo, pr) } as const;
  if (end.merged) return end.mergeSha === null ? [] : [{ ...base, kind: "PRMerged", fields: [pr, end.mergeSha], keys: { pr, mergeSha: end.mergeSha, mergedBy: end.mergedBy } }];
  if (end.closedAt === null) return [];
  const closedAt = utcSeconds(end.closedAt);
  return [{ ...base, kind: "PRClosed", fields: [pr, closedAt], keys: { pr, closedAt } }];
}

function review(repo: string, pr: number, id: number, action: "submitted" | "dismissed"): IdentityObservation {
  const kind = action === "submitted" ? "ReviewSubmitted" : "ReviewDismissed";
  return { rule: "identity", kind, repo, subject: prSubject(repo, pr), fields: [pr, id, action], keys: { pr, reviewId: id, action } };
}

/** `stamp` is `updated_at` in UTC seconds, or `deleted`. */
function ruleset(repo: string, id: number, stamp: string): IdentityObservation {
  return { rule: "identity", kind: "RulesChanged", repo, subject: repo, fields: [id, stamp], keys: { rulesetId: id, updatedAt: stamp } };
}

const Repository = z.object({ full_name: z.string() });
const lower = (repository: { full_name: string }): string => repository.full_name.toLowerCase();

const PullRequestDelivery = z.object({
  action: z.string(),
  number: z.number(),
  pull_request: z.object({
    head: z.object({ sha: z.string() }),
    base: z.object({ ref: z.string() }),
    merged: z.boolean().nullable().optional(),
    merge_commit_sha: z.string().nullable(),
    closed_at: z.string().nullable(),
    merged_by: z.object({ login: z.string() }).nullable().optional(),
  }),
  repository: Repository,
});

/** Every `pull_request` delivery reports the head and base; only `closed` reports how the PR ended. */
export function fromPullRequestDelivery(body: unknown): RepoObservation[] {
  const { action, number: pr, pull_request: p, repository } = PullRequestDelivery.parse(body);
  const repo = lower(repository);
  const end = action === "closed" ? ending(repo, pr, { merged: p.merged === true, mergeSha: p.merge_commit_sha, closedAt: p.closed_at, mergedBy: p.merged_by?.login ?? null }) : [];
  return [...prTransitions(repo, pr, p.head.sha, p.base.ref), ...end];
}

const ReviewDelivery = z.object({
  action: z.string(),
  review: z.object({ id: z.number() }),
  pull_request: z.object({ number: z.number() }),
  repository: Repository,
});

/** A `pull_request_review` delivery; an edit changes the body, not the verdict, so it is no occurrence. */
export function fromReviewDelivery(body: unknown): IdentityObservation | undefined {
  const { action, review: r, pull_request: p, repository } = ReviewDelivery.parse(body);
  if (action !== "submitted" && action !== "dismissed") return undefined;
  return review(lower(repository), p.number, r.id, action);
}

const RulesetDelivery = z.object({
  action: z.string(),
  repository_ruleset: z.object({ id: z.number(), updated_at: z.string() }),
  repository: Repository.optional(),
});

/**
 * A `repository_ruleset` delivery. A deletion keeps the last `updated_at`, so it keys as `deleted` instead; the backstop
 * never sees a deleted ruleset, so only the webhook reports one. An organization ruleset names no repository.
 */
export function fromRulesetDelivery(body: unknown): IdentityObservation | undefined {
  const { action, repository_ruleset: r, repository } = RulesetDelivery.parse(body);
  if (repository === undefined) return undefined;
  return ruleset(lower(repository), r.id, action === "deleted" ? "deleted" : utcSeconds(r.updated_at));
}

const PushDelivery = z.object({
  ref: z.string(),
  after: z.string(),
  deleted: z.boolean(),
  repository: Repository.extend({ default_branch: z.string() }),
});

/** A `push` to the default branch moves main; a push elsewhere, or a deletion, does not. */
export function fromPushDelivery(body: unknown): TransitionObservation | undefined {
  const { ref, after, deleted, repository } = PushDelivery.parse(body);
  if (deleted || ref !== `refs/heads/${repository.default_branch}`) return undefined;
  return fromBackstopMain(repository.full_name, repository.default_branch, after);
}

/** The open-PR node the GraphQL backstop reads (packages/github backstop-query `GhOpenPr`). */
export interface BackstopOpenPr {
  number: number;
  headRefOid: string;
  baseRefName: string;
  reviews: { nodes: { databaseId: number; state: string }[] };
}

/** The merged-or-closed PR node the GraphQL backstop reads (`GhDonePr`). */
export interface BackstopDonePr {
  number: number;
  merged: boolean;
  mergedBy: { login: string } | null;
  mergeCommit: { oid: string } | null;
  closedAt: string | null;
}

/** A pending review is a draft no one else sees; a dismissed one shows only its dismissal. */
function reviewAction(state: string): "submitted" | "dismissed" | undefined {
  if (state === "PENDING") return undefined;
  return state === "DISMISSED" ? "dismissed" : "submitted";
}

export function fromBackstopOpenPr(repo: string, pr: BackstopOpenPr): RepoObservation[] {
  const lowered = repo.toLowerCase();
  const reviews = pr.reviews.nodes.flatMap((node) => {
    const action = reviewAction(node.state);
    return action === undefined ? [] : [review(lowered, pr.number, node.databaseId, action)];
  });
  return [...prTransitions(lowered, pr.number, pr.headRefOid, pr.baseRefName), ...reviews];
}

export function fromBackstopDonePr(repo: string, pr: BackstopDonePr): IdentityObservation[] {
  return ending(repo.toLowerCase(), pr.number, { merged: pr.merged, mergeSha: pr.mergeCommit?.oid ?? null, closedAt: pr.closedAt, mergedBy: pr.mergedBy?.login ?? null });
}

/** The backstop's ruleset read: id to `updated_at` (packages/github conditional-reads). */
export function fromBackstopRulesets(repo: string, rulesets: Record<number, string>): IdentityObservation[] {
  return Object.entries(rulesets).map(([id, updatedAt]) => ruleset(repo.toLowerCase(), Number(id), utcSeconds(updatedAt)));
}

/** The tip of `branch` as the backstop's history read sees it. */
export function fromBackstopMain(repo: string, branch: string, oid: string): TransitionObservation {
  const lowered = repo.toLowerCase();
  return transition("MainMoved", lowered, `${lowered}:${branch}`, oid);
}

/**
 * The event to append for one observation. One delivery can yield a row per kind, so the delivery id carries the kind:
 * an exact retry still collapses, and a delivery's head row does not shadow its base row.
 */
export function repoEvent(observation: RepoObservation, transport: Transport, key: RepoKeyFn = repoKey): IdentityEvent | TransitionEvent {
  const common = {
    source: transport.source,
    kind: observation.kind,
    repo: observation.repo,
    subject: observation.subject,
    ...(transport.deliveryId !== undefined && { deliveryId: `webhook:${transport.deliveryId}:${observation.kind}` }),
    observedAt: transport.observedAt,
  };
  if (observation.rule === "transition") {
    const { value } = observation;
    return { ...common, rule: "transition", keyBase: `v1|${observation.kind}|${observation.repo}|${observation.subject}|${value}`, value, keys: {}, payload: { value } };
  }
  return { ...common, rule: "identity", occurrenceKey: key(observation), keys: observation.keys, payload: observation.keys };
}
