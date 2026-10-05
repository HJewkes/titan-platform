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

export async function upsertComment(wire: GitHubWire, login: () => Promise<string>, repo: RepoSlug, number: number, marker: string, body: string): Promise<WriteResult<{ id: number }>> {
  const [self, comments] = await Promise.all([login(), wire.listIssueComments(repo, number)]);
  const existing = comments.find((comment) => comment.author === self && holdsMarker(comment.body, marker));
  if (existing) return { id: existing.id, done: false, skipped: "exists" };
  return { id: (await wire.createComment(repo, number, body)).id, done: true };
}
