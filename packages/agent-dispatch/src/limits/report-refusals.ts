import type { LimitsPrStatus, LimitsRefusal } from "./report-input.js";
import type { LimitsBinding, RefusalBlocker, RefusalKindReport } from "./report-schema.js";

/** The claimed refusal the planner gives a unit the ledger already holds: bookkeeping, reported as `supply.seeded`. */
export const BOOKKEEPING_REASON = "held in the burndown claim ledger";

/** CC-1097: the refusal kinds a capacity lever produces. */
export const CAP_KINDS: ReadonlySet<string> = new Set(["role-cap", "worktrees", "slots", "budget"]);

const PR_KINDS: ReadonlySet<string> = new Set(["file-overlap", "open-pr"]);
const TOP_BLOCKERS = 5;
const PR_LEAD = /^#(\d+)\b/;
const TOUCHES = /^#\d+ touches (.+)$/;

export const isBookkeeping = (r: LimitsRefusal): boolean => r.kind === "claimed" && r.reason === BOOKKEEPING_REASON;

/** Each refused task once, under its first refusal; a refusal that names no task counts on its own (CC-1186). */
export function firstRefusalPerTask(refusals: readonly LimitsRefusal[]): LimitsRefusal[] {
  const seen = new Set<string>();
  return refusals.filter((r) => {
    if (r.task === undefined) return true;
    const key = JSON.stringify([r.initiative, r.task]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function tallyByKind(refusals: readonly LimitsRefusal[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const r of refusals) tally[r.kind] = (tally[r.kind] ?? 0) + 1;
  return tally;
}

function prOf(r: LimitsRefusal): { pr: number; repo?: string } | undefined {
  if (r.blocker !== undefined && "pr" in r.blocker) return { pr: r.blocker.pr, repo: r.blocker.repo };
  const lead = PR_LEAD.exec(r.reason);
  return lead?.[1] === undefined ? undefined : { pr: Number(lead[1]) };
}

const unitOf = (r: LimitsRefusal): string | undefined =>
  r.task === undefined ? undefined : r.slice === undefined ? r.task : `${r.task} ${r.slice}`;

const pushNew = (list: string[], item: string | undefined): void => {
  if (item !== undefined && !list.includes(item)) list.push(item);
};

/** The PRs refusals of one kind name, most refusals first, then lowest PR number. */
export function topBlockers(refusals: readonly LimitsRefusal[], prs: readonly LimitsPrStatus[]): RefusalBlocker[] {
  const byPr = new Map<number, RefusalBlocker>();
  for (const r of refusals) {
    const ref = prOf(r);
    if (ref === undefined) continue;
    const entry = byPr.get(ref.pr) ?? newBlocker(ref, prs);
    entry.refusals += 1;
    pushNew(entry.slices, unitOf(r));
    pushNew(entry.files, TOUCHES.exec(r.reason)?.[1]);
    byPr.set(ref.pr, entry);
  }
  return [...byPr.values()].sort((a, b) => b.refusals - a.refusals || a.pr - b.pr).slice(0, TOP_BLOCKERS);
}

function newBlocker(ref: { pr: number; repo?: string }, prs: readonly LimitsPrStatus[]): RefusalBlocker {
  const status = prs.find((p) => p.pr === ref.pr)?.status ?? "unknown";
  return { pr: ref.pr, ...(ref.repo === undefined ? {} : { repo: ref.repo }), refusals: 0, slices: [], files: [], status };
}

/** Counts per kind as the tick row has them, less bookkeeping, each PR kind with its top blockers. */
export function refusalKinds(
  refusals: readonly LimitsRefusal[],
  prs: readonly LimitsPrStatus[],
): Record<string, RefusalKindReport> {
  const counted = firstRefusalPerTask(refusals).filter((r) => !isBookkeeping(r));
  const report: Record<string, RefusalKindReport> = {};
  for (const [kind, count] of Object.entries(tallyByKind(counted))) {
    const blockers = PR_KINDS.has(kind)
      ? topBlockers(
          refusals.filter((r) => r.kind === kind),
          prs,
        )
      : [];
    report[kind] = { count, blockers };
  }
  return report;
}

/** `plan-blocked` split into units waiting on a dependency and the dead-task classes, by the reason's lead word. */
export function planBlockedSplit(refusals: readonly LimitsRefusal[]): { depBlocked: number; dead: Record<string, number> } {
  const split = { depBlocked: 0, dead: {} as Record<string, number> };
  for (const r of firstRefusalPerTask(refusals)) {
    if (r.kind !== "plan-blocked") continue;
    const lead = r.reason.split(":")[0]?.trim() || "unexplained";
    if (lead === "dep-blocked") split.depBlocked += 1;
    else split.dead[lead] = (split.dead[lead] ?? 0) + 1;
  }
  return split;
}

/** The first capacity lever, in rank order, that refused; else supply, with what the ready set ran out against. */
export function bindingOf(refusals: readonly LimitsRefusal[], ready: number): LimitsBinding {
  const hit = refusals.find((r) => CAP_KINDS.has(r.kind) && r.gate !== undefined);
  if (hit?.gate !== undefined) {
    const { kind, initiative, task } = hit;
    return { kind: "lever", refusal: kind, initiative, ...(task === undefined ? {} : { task }), ...hit.gate };
  }
  const counted = firstRefusalPerTask(refusals).filter((r) => !isBookkeeping(r));
  return { kind: "supply", ready, mix: tallyByKind(counted) };
}
