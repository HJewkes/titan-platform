import type { WorkflowRun, WorkflowRunStore } from "@titan-design/workflow";
import type { FactoryHost } from "../host.js";
import type { DigestInput } from "./seat-digest-items.js";
import type { ShepherdServices } from "./services.js";
import type { Registration } from "./store.js";
import { rowsWithRuns } from "./watch-rows.js";

/** Far enough back that a failure re-registered over within one paced send is still found, and short enough to stay cheap. */
const SUPERSEDED_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;

const prKey = (repo: string | undefined, pr: string | number | null | undefined, branch: string | null | undefined): string => `${repo}#${pr ?? branch}`;
const registrationKey = (registration: Pick<Registration, "repo" | "pr" | "branch">): string => prKey(registration.repo, registration.pr, registration.branch);

function failedSince(runs: WorkflowRunStore, completedSince: string): WorkflowRun[] {
  const found: WorkflowRun[] = [];
  for (let after = ""; ; ) {
    const page = runs.page(["failed"], { after, limit: PAGE_SIZE, completedSince });
    found.push(...page);
    if (page.length < PAGE_SIZE) return found;
    after = page.at(-1)!.id;
  }
}

/**
 * Shepherd runs that failed in the window and that a re-register has since replaced (TP-5049). A registration names only
 * its PR's latest run, so a failure re-registered over before its paced digest went out was never read again and its
 * seat was never told. Each comes back on its PR's current row with the run id swapped, marked `superseded`.
 */
export async function supersededFailures(host: FactoryHost, services: ShepherdServices, now: Date): Promise<DigestInput[]> {
  const store = services.store.get();
  const orphans = new Map<string, WorkflowRun[]>();
  for (const run of failedSince(host.runs, new Date(now.getTime() - SUPERSEDED_WINDOW_MS).toISOString())) {
    if (run.workflowName !== "shepherd-pr" || store.byRun(run.id) !== undefined) continue;
    const key = prKey(run.params.repo, run.params.pr, run.params.branch);
    orphans.set(key, [...(orphans.get(key) ?? []), run]);
  }
  if (orphans.size === 0) return [];
  const current = await rowsWithRuns(host, services, (registration) => orphans.has(registrationKey(registration)));
  return current.flatMap(({ row, registration }) => (orphans.get(registrationKey(registration)) ?? []).map((run) => ({ row: { ...row, runId: run.id }, run, superseded: true as const })));
}
