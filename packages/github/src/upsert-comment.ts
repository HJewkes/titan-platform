import { pause, writeWithReadBack, type RetrySchedule, type Sleep } from "./write-read-back.js";
import type { GitHubWire, RepoSlug, WriteResult } from "./port-types.js";

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

/** The fourth post is the last and is not read back; its error is thrown as is. */
const POST_SCHEDULE: RetrySchedule = { delays: POST_RETRY_DELAYS_MS, attempts: POST_RETRY_DELAYS_MS.length + 1, rawError: true };

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
function postWithReadBack(wire: GitHubWire, self: string, target: { repo: RepoSlug; number: number; marker: string; body: string }, sleep: Sleep): Promise<WriteResult<{ id: number }>> {
  const { repo, number, marker, body } = target;
  const post = async (): Promise<WriteResult<{ id: number }>> => ({ id: (await wire.createComment(repo, number, body)).id, done: true });
  const landed = async (): Promise<WriteResult<{ id: number }> | undefined> => {
    const own = await findOwn(wire, self, repo, number, marker);
    return own ? { id: own.id, done: true } : undefined;
  };
  return writeWithReadBack(`comment POST ${repo}#${number}`, post, landed, sleep, POST_SCHEDULE);
}
