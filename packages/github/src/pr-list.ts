import type { PullRequest } from "./port.js";

/**
 * The open PRs, or `notModified` when they are unchanged since the read that answered `etag`. Rows carry no `behind`
 * and an `unknown` mergeable state, like every list row, and a change to either does not change the ETag.
 */
export type OpenPrList = { notModified: true } | { notModified: false; prs: PullRequest[]; etag: string | null };

export interface OpenPrRequest {
  head: string;
  base: string;
  title: string;
  body: string;
}
