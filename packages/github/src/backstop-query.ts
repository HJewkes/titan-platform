import { redact } from "./redact.js";
import type { Rest } from "./rest.js";

export const OPEN_PAGE = 50;
export const DONE_PAGE = 20;
export const HISTORY_PAGE = 50;
export const CONTEXTS_PAGE = 50;
export const REVIEWS_PAGE = 20;
/** Follow-up pages read one PR or commit each, so they take GitHub's largest page for the same single request. */
export const FOLLOW_UP_PAGE = 100;

/** What GitHub charged for one query, read from the query itself. */
export interface RateLimit {
  cost: number;
  remaining: number;
  resetAt: string;
}

export interface GhPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export type GhContext =
  | { __typename: "CheckRun"; databaseId: number; name: string; status: string; conclusion: string | null; completedAt: string | null }
  | { __typename: "StatusContext"; context: string; state: string; createdAt: string };

export interface GhContexts {
  pageInfo: GhPageInfo;
  nodes: GhContext[];
}

export interface GhRollup {
  statusCheckRollup: { contexts: GhContexts } | null;
}

export interface GhReview {
  databaseId: number;
  state: string;
  submittedAt: string | null;
}

export interface GhReviews {
  pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
  nodes: GhReview[];
}

export interface GhOpenPr {
  number: number;
  headRefOid: string;
  baseRefName: string;
  updatedAt: string;
  commits: { nodes: { commit: GhCommit }[] };
  reviews: GhReviews;
}

export interface GhDonePr {
  number: number;
  merged: boolean;
  mergedBy: { login: string } | null;
  mergeCommit: { oid: string } | null;
  closedAt: string | null;
  updatedAt: string;
}

export interface GhConnection<N> {
  pageInfo: GhPageInfo;
  nodes: N[];
}

export type GhCommit = { oid: string } & GhRollup;

export interface GhHistoryTarget {
  oid: string;
  history: GhConnection<GhCommit>;
}

export interface GhSnapshotData {
  rateLimit: RateLimit;
  repository: {
    open?: GhConnection<GhOpenPr>;
    done?: GhConnection<GhDonePr>;
    ref?: { target: GhHistoryTarget | null } | null;
  } | null;
}

const CONTEXTS_FRAGMENT = `fragment Contexts on StatusCheckRollupContextConnection {
  pageInfo { hasNextPage endCursor }
  nodes { __typename
    ... on CheckRun { databaseId name status conclusion completedAt }
    ... on StatusContext { context state createdAt } }
}`;

const REVIEW_FIELDS = "pageInfo { hasPreviousPage startCursor } nodes { databaseId state submittedAt }";

/** One document for every page: a later page includes only the ranges that still have pages, so it re-reads nothing. */
export const SNAPSHOT_QUERY = `query($owner: String!, $name: String!, $branch: String!, $since: GitTimestamp!, $openAfter: String, $doneAfter: String, $historyAfter: String, $withOpen: Boolean!, $withDone: Boolean!, $withHistory: Boolean!) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    open: pullRequests(states: OPEN, first: ${OPEN_PAGE}, after: $openAfter, orderBy: {field: UPDATED_AT, direction: DESC}) @include(if: $withOpen) {
      pageInfo { hasNextPage endCursor }
      nodes { number headRefOid baseRefName updatedAt
        commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: ${CONTEXTS_PAGE}) { ...Contexts } } } } }
        reviews(last: ${REVIEWS_PAGE}) { ${REVIEW_FIELDS} } }
    }
    done: pullRequests(states: [MERGED, CLOSED], first: ${DONE_PAGE}, after: $doneAfter, orderBy: {field: UPDATED_AT, direction: DESC}) @include(if: $withDone) {
      pageInfo { hasNextPage endCursor }
      nodes { number merged mergedBy { login } mergeCommit { oid } closedAt updatedAt }
    }
    ref(qualifiedName: $branch) @include(if: $withHistory) { target { ... on Commit { oid
      history(first: ${HISTORY_PAGE}, since: $since, after: $historyAfter) {
        pageInfo { hasNextPage endCursor }
        nodes { oid statusCheckRollup { contexts(first: ${CONTEXTS_PAGE}) { ...Contexts } } } } } } }
  }
}
${CONTEXTS_FRAGMENT}`;

export const CONTEXTS_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit {
    statusCheckRollup { contexts(first: ${FOLLOW_UP_PAGE}, after: $after) { ...Contexts } } } } }
}
${CONTEXTS_FRAGMENT}`;

export const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $before: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviews(last: ${FOLLOW_UP_PAGE}, before: $before) { ${REVIEW_FIELDS} } } }
}`;

export type GhContextsData = { rateLimit: RateLimit; repository: { object: GhRollup | null } | null };
export type GhReviewsData = { rateLimit: RateLimit; repository: { pullRequest: { reviews: GhReviews } | null } | null };

/**
 * Unlike `graphql()`, any `errors` entry fails the read even beside `data`: a partial answer would read as a PR with no
 * CI or no review.
 */
export async function postWhole<T extends { rateLimit: RateLimit }>(api: Rest, what: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const answer = await api.send<{ data?: T | null; errors?: { message: string }[] }>("POST", "graphql", {}, JSON.stringify({ query, variables }));
  const errors = answer.errors ?? [];
  if (errors.length > 0 || !answer.data) throw new Error(redact(`${what} unreadable: ${errors.map((error) => error.message).join("; ") || "no data"}`, []));
  return answer.data;
}

/** GitHub's formula: the requests needed to fill every connection at its page size, over 100, rounded, at least 1. */
export function graphqlPoints(requests: number): number {
  return Math.max(1, Math.round(requests / 100));
}

/** The requests one snapshot page asks for, per included range; the nested connections count once per parent node. */
export function snapshotRequests(ranges: { open: boolean; done: boolean; history: boolean }): number {
  const open = ranges.open ? 1 + OPEN_PAGE * 3 : 0;
  const done = ranges.done ? 1 : 0;
  const history = ranges.history ? 1 + HISTORY_PAGE : 0;
  return open + done + history;
}
