import type { OwnerItem } from "./schema.js";

export const STALE_RULES = ["pr-merged", "head-moved", "task-done", "asker-retired"] as const;
export type StaleRule = (typeof STALE_RULES)[number];

/** An asker's declared `onNoAnswer` meaning "wait for the owner": nothing was done in their absence. */
export const PARKED = "parked";

const FULL_SHA = /^[0-9a-f]{40}$/;
const PINNED_PR_KEY = /^pr:([\w.-]+\/[\w.-]+#\d+)@([0-9a-f]{40})$/;

/**
 * Source facts read by the caller, as of one moment. A missing entry is no fact, and no
 * fact never labels an item stale. PRs are keyed `<owner>/<repo>#<n>`, case-insensitively,
 * the same ref consolidate's `heads[pr]` uses.
 */
export interface StaleEvidence {
  prs?: Readonly<Record<string, { state: "open" | "closed" | "merged"; head?: string }>>;
  tasks?: Readonly<Record<string, { status: string }>>;
  askers?: Readonly<Record<string, { retired: boolean }>>;
  /** Item id to the `onNoAnswer` its asker declared at the source; absent when none was declared. */
  onNoAnswer?: Readonly<Record<string, string>>;
}

export interface StaleLabel {
  status: "gone-elsewhere";
  rule: StaleRule;
  /** `pr-merged:<pr>`, `new-head:<sha>`, `task-done:<id>` or `asker-retired:<asker>`. */
  reason: string;
}

interface PinnedPr {
  pr: string;
  sha: string;
}

function pinnedPrs(item: OwnerItem): PinnedPr[] {
  return item.keys.flatMap((key) => {
    const match = PINNED_PR_KEY.exec(key.toLowerCase());
    return match ? [{ pr: match[1]!, sha: match[2]! }] : [];
  });
}

function prFacts(evidence: StaleEvidence): Map<string, { state: string; head?: string }> {
  return new Map(Object.entries(evidence.prs ?? {}).map(([pr, fact]) => [pr.toLowerCase(), fact]));
}

function prRefs(item: OwnerItem): string[] {
  return item.keys.flatMap((key) => {
    const normal = key.toLowerCase();
    if (!normal.startsWith("pr:")) return [];
    const at = normal.lastIndexOf("@");
    return [at < 0 ? normal.slice(3) : normal.slice(3, at)];
  });
}

function merged(item: OwnerItem, evidence: StaleEvidence): StaleLabel | null {
  const facts = prFacts(evidence);
  const pr = prRefs(item).find((ref) => facts.get(ref)?.state === "merged");
  return pr === undefined ? null : label("pr-merged", `pr-merged:${pr}`);
}

/** Only a full live head is a fact; an unpinned or short key pins nothing, so it never moves. */
function headMoved(item: OwnerItem, evidence: StaleEvidence): StaleLabel | null {
  const facts = prFacts(evidence);
  for (const { pr, sha } of pinnedPrs(item)) {
    const head = facts.get(pr)?.head?.toLowerCase();
    if (head !== undefined && FULL_SHA.test(head) && head !== sha) return label("head-moved", `new-head:${head}`);
  }
  return null;
}

function taskDone(item: OwnerItem, evidence: StaleEvidence): StaleLabel | null {
  const id = item.keys
    .filter((key) => key.startsWith("task:"))
    .map((key) => key.slice("task:".length))
    .find((task) => evidence.tasks?.[task]?.status === "done");
  return id === undefined ? null : label("task-done", `task-done:${id}`);
}

/**
 * A retired asker went stale only if it declared what it would do unanswered and that was
 * not to park: then its default has been taken. With no declaration, or a parked one, the
 * question still stands for whoever resumes the work.
 */
function askerRetired(item: OwnerItem, evidence: StaleEvidence): StaleLabel | null {
  if (item.asker === undefined || evidence.askers?.[item.asker]?.retired !== true) return null;
  const onNoAnswer = evidence.onNoAnswer?.[item.id]?.trim();
  if (!onNoAnswer || onNoAnswer.toLowerCase() === PARKED) return null;
  return label("asker-retired", `asker-retired:${item.asker}`);
}

function label(rule: StaleRule, reason: string): StaleLabel {
  return { status: "gone-elsewhere", rule, reason };
}

const RULES = [merged, headMoved, taskDone, askerRetired];

/**
 * Labels an open item stale when its sources' own facts say the question is gone, or
 * returns null. Rules run in `STALE_RULES` order and the first match wins: a merged PR
 * outranks the head it moved to. A closed item is never relabelled.
 */
export function staleLabel(item: OwnerItem, evidence: StaleEvidence): StaleLabel | null {
  if (item.status !== "open") return null;
  for (const rule of RULES) {
    const found = rule(item, evidence);
    if (found) return found;
  }
  return null;
}
