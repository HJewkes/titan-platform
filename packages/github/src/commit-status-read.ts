import type { CommitStatus } from "./port.js";
import type { Rest } from "./rest.js";

/** A list shorter than `total_count` throws rather than read as complete, because a missing failure would read as green. */
export async function listCommitStatuses(api: Rest, repo: string, sha: string): Promise<CommitStatus[]> {
  let total = 0;
  const statuses = await api.pages(`repos/${repo}/commits/${sha}/status`, { per_page: "100" }, (page: { total_count: number; statuses: GhCommitStatus[] }) => {
    total = page.total_count;
    return page.statuses;
  });
  if (statuses.length !== total) throw new Error(`the combined status of ${sha} listed ${statuses.length} of ${total} statuses`);
  return statuses.map(commitStatusOf);
}

interface GhCommitStatus {
  context: string;
  state: string;
  target_url?: string | null;
  description?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

function commitStatusOf(status: GhCommitStatus): CommitStatus {
  const { context, state } = status;
  return { context, state, targetUrl: status.target_url ?? null, description: status.description ?? null, createdAt: status.created_at ?? null, updatedAt: status.updated_at ?? null };
}
