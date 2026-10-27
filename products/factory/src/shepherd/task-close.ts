import type { GitHubPort } from "@titan-design/github";
import type { Registration } from "./store.js";

/** `shepherd.taskClose`: `keep` closes a registered PR's task on every merge; `last-slice-only` only on its last slice (TP-4274). */
export type TaskClose = "keep" | "last-slice-only";

/** One line of the PR body, in any case: `Last slice: yes` or `Last slice: no`. */
const LAST_SLICE_LINE = /^[ \t]*last slice:[ \t]*(yes|no)[ \t]*$/im;

/** What the PR body says of its last slice, or undefined when it has no marker line; the first marker wins. */
export function lastSliceMarker(body: string | undefined): "yes" | "no" | undefined {
  const answer = LAST_SLICE_LINE.exec(body ?? "")?.[1]?.toLowerCase();
  return answer === "yes" || answer === "no" ? answer : undefined;
}

/**
 * Under `last-slice-only` a merge may close its task when it says it is the last slice, or when it is no named slice, does
 * not say it is not the last, and no other open PR is registered with the task. A close still passes the plan and epic checks.
 */
export function closesTask(registration: Registration, body: string | undefined, otherOpen: readonly string[]): boolean {
  const marker = lastSliceMarker(body);
  if (registration.lastSlice || marker === "yes") return true;
  return registration.slice === null && marker !== "no" && otherOpen.length === 0;
}

/** The open PRs, as `owner/repo#n`, of every other registration with this one's task; a branch registration matches its open PR's head. */
export async function otherOpenOnTask(port: GitHubPort, registrations: readonly Registration[], registration: Registration): Promise<string[]> {
  const others = registrations.filter((other) => other.runId !== registration.runId && other.task === registration.task);
  const open: string[] = [];
  for (const repo of new Set(others.map((other) => other.repo))) {
    const prs = await port.listOpenPrs(repo);
    for (const other of others.filter((candidate) => candidate.repo === repo)) {
      const pr = prs.find((candidate) => (other.pr === null ? candidate.headRef === other.branch : candidate.number === other.pr));
      if (pr !== undefined) open.push(`${repo}#${pr.number}`);
    }
  }
  return open;
}
