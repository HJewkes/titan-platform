import { graphql } from "./graphql.js";
import type { Rest } from "./rest.js";

/** One GraphQL page each for reviews and commits; `truncated` says a list was cut at it. */
export const PR_OUTCOME_CAP = 100;

export interface PrOutcomeReview {
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. */
  state: string;
  /** Null for a pending review, which has not been submitted. */
  submittedAt: string | null;
}

/** How a PR ended, or that it has not: the dates a lead-time or review-latency reader needs, in one read. */
export interface PrOutcome {
  state: "open" | "closed" | "merged";
  mergedAt: string | null;
  closedAt: string | null;
  reviews: PrOutcomeReview[];
  /** Each commit's committed date, oldest first; null when GitHub reports none. */
  commitDates: (string | null)[];
  /** True when the PR has more than `PR_OUTCOME_CAP` reviews or commits, so a list is short. */
  truncated: boolean;
}

/** Named so a caller that reports only an error's class still says GitHub's answer had the wrong shape. */
export class PrOutcomeMalformed extends Error {
  constructor(what: string) {
    super(`pull request outcome unreadable: ${what}`);
    this.name = "PrOutcomeMalformed";
  }
}

const QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state
      mergedAt
      closedAt
      reviews(first: ${PR_OUTCOME_CAP}) { pageInfo { hasNextPage } nodes { state submittedAt } }
      commits(first: ${PR_OUTCOME_CAP}) { pageInfo { hasNextPage } nodes { commit { committedDate } } }
    }
  }
}`;

type OutcomeData = { repository?: { pullRequest?: unknown } | null };

export async function readPrOutcome(api: Rest, repo: string, number: number): Promise<PrOutcome> {
  const [owner, name] = repo.split("/");
  const raw = await graphql(api, `outcome of ${repo}#${number}`, QUERY, { owner, name, number }, (data: OutcomeData) => data.repository?.pullRequest);
  return parsePrOutcome(raw);
}

const STATES: ReadonlyMap<string, PrOutcome["state"]> = new Map([["OPEN", "open"], ["CLOSED", "closed"], ["MERGED", "merged"]]);

function parsePrOutcome(raw: unknown): PrOutcome {
  const pr = record(raw, "pullRequest");
  const state = STATES.get(text(pr.state, "state"));
  if (state === undefined) throw new PrOutcomeMalformed(`state ${JSON.stringify(pr.state)} is not OPEN, CLOSED or MERGED`);
  const reviews = connection(pr.reviews, "reviews");
  const commits = connection(pr.commits, "commits");
  return {
    state,
    mergedAt: nullableText(pr.mergedAt, "mergedAt"),
    closedAt: nullableText(pr.closedAt, "closedAt"),
    reviews: reviews.nodes.map((node) => ({ state: text(record(node, "review").state, "review state"), submittedAt: nullableText(record(node, "review").submittedAt, "review submittedAt") })),
    commitDates: commits.nodes.map((node) => nullableText(record(record(node, "commit node").commit ?? {}, "commit").committedDate, "committedDate")),
    truncated: reviews.more || commits.more,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PrOutcomeMalformed(`${what} is not an object`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new PrOutcomeMalformed(`${what} is not a string`);
  return value;
}

function nullableText(value: unknown, what: string): string | null {
  return value === null || value === undefined ? null : text(value, what);
}

function connection(value: unknown, what: string): { nodes: unknown[]; more: boolean } {
  const page = record(value, what);
  if (!Array.isArray(page.nodes)) throw new PrOutcomeMalformed(`${what} has no nodes list`);
  return { nodes: page.nodes, more: record(page.pageInfo, `${what} pageInfo`).hasNextPage === true };
}
