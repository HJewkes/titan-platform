import type { CheckRun, CommitStatus } from "./port.js";
import { GITHUB_ACTIONS_APP_ID } from "./readiness.js";

/**
 * Stands each named commit-status context in as a GitHub Actions check run at `headSha`, for a repo whose CI posts a
 * status instead of running Actions, so the check-run judges count it like the Actions run it replaces. `success` is a
 * passed run, `pending` a running one, and any other state a run that concluded red. A context with no status is a
 * queued run, so it holds the head instead of letting other runs make it green. The run has no start time, because the
 * newest status only says when it was posted, not when the work it reports began.
 */
export function statusCheckRuns(statuses: readonly CommitStatus[], headSha: string, contexts: readonly string[]): CheckRun[] {
  return [...new Set(contexts)].map((context, index) => statusRun(statuses.find((status) => status.context === context), context, headSha, -(index + 1)));
}

/** Negative ids never collide with the ids GitHub assigns to real check runs. */
function statusRun(status: CommitStatus | undefined, name: string, headSha: string, id: number): CheckRun {
  const base = { id, name, headSha, startedAt: null, appId: GITHUB_ACTIONS_APP_ID, workflowRunId: null, pullRequests: [] };
  const posted = { title: status?.description ?? null, url: status?.targetUrl ?? "" };
  if (status === undefined) return { ...base, ...posted, status: "queued", conclusion: null, completedAt: null };
  if (status.state === "pending") return { ...base, ...posted, status: "in_progress", conclusion: null, completedAt: null };
  return { ...base, ...posted, status: "completed", conclusion: status.state, completedAt: status.updatedAt ?? status.createdAt ?? null };
}
