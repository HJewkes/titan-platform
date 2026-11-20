import type { RefActivity } from "./port-records.js";
import type { Rest } from "./rest.js";

interface GhActivity {
  before: string;
  after: string;
  ref: string;
  activity_type: string;
  actor?: { login?: string } | null;
}

/** GitHub's "List repository activities" for one branch, newest first: the first page of 100. */
export async function listRefActivity(api: Rest, repo: string, branch: string): Promise<RefActivity[]> {
  const activity = await api.get<GhActivity[]>(`repos/${repo}/activity`, { ref: `refs/heads/${branch}`, per_page: "100" });
  return activity.map((entry) => ({ before: entry.before, after: entry.after, ref: entry.ref, activityType: entry.activity_type, actor: entry.actor?.login ?? null }));
}
