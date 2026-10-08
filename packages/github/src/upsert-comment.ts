import { isRetryableWrite } from "./update-branch-retry.js";
import type { GitHubWire, RepoSlug, WriteResult } from "./port.js";

/** Resolved once per port; a failed lookup is not remembered. */
export function memoizedLogin(wire: GitHubWire): () => Promise<string> {
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= wire.getAuthenticatedLogin().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}

const holdsMarker = (body: string, marker: string): boolean => body.split(/\r?\n/).some((line) => line.trimEnd() === marker);

/** Waits before attempts 2 to 4 of the post, so a persistent failure surfaces after about nine seconds. */
const POST_RETRY_DELAYS_MS = [1000, 3000, 5000];

export type Sleep = (ms: number) => Promise<void>;
const pause: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function upsertComment(wire: GitHubWire, login: () => Promise<string>, repo: RepoSlug, number: number, marker: string, body: string, sleep: Sleep = pause): Promise<WriteResult<{ id: number }>> {
  const self = await login();
  const existing = await findOwn(wire, self, repo, number, marker);
  if (existing) return { id: existing.id, done: false, skipped: "exists" };
  return postWithReadBack(wire, self, { repo, number, marker, body }, sleep);
}

async function findOwn(wire: GitHubWire, self: string, repo: RepoSlug, number: number, marker: string): Promise<{ id: number } | undefined> {
  const comments = await wire.listIssueComments(repo, number);
  return comments.find((comment) => comment.author === self && holdsMarker(comment.body, marker));
}

/** A 5xx or an unreadable answer may hide a post that landed, so each retry first reads the comments back and counts the marker as done. */
async function postWithReadBack(wire: GitHubWire, self: string, target: { repo: RepoSlug; number: number; marker: string; body: string }, sleep: Sleep): Promise<WriteResult<{ id: number }>> {
  const { repo, number, marker, body } = target;
  for (let attempt = 0; ; attempt++) {
    try {
      return { id: (await wire.createComment(repo, number, body)).id, done: true };
    } catch (error) {
      const delay = POST_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryableWrite(error)) throw error;
      await sleep(delay);
      const landed = await findOwn(wire, self, repo, number, marker).catch(() => undefined);
      if (landed) return { id: landed.id, done: true };
    }
  }
}
