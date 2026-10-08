// A copy of titan-design's `TaskStage` (packages/ui/src/components/custom/ActiveWork/task-stage.ts), which no released
// @titan-design/react-ui exports yet. Swap this for `import type { TaskStage } from "@titan-design/react-ui"` once the
// console's pinned react-ui carries it; task-stage.test.ts fails while the two lists differ.
export const TASK_STAGES = ["blocked", "ready", "in-progress", "review", "done"] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

/** Which rule produced a stage. Only `default` is a guess: it means no evidence was found either way. */
export type StageRule = "status-done" | "open-pr" | "live-ref" | "dependency" | "unresolved-dependency" | "hold" | "open-slices" | "merged-commit" | "default";

interface StageVerdict {
  stage: TaskStage;
  rule: StageRule;
  reason: string;
  guessed: boolean;
}

export interface StagedTask {
  id: string;
  status: "open" | "done";
  tags?: readonly string[];
  notes?: string;
}

/** A git ref or pull request whose name carries a task id. */
export interface RefEvidence {
  repo: string;
  name: string;
  kind: "worktree" | "branch";
  /** Unix seconds of the ref's tip commit. */
  tipAt: number;
}

export interface PrEvidence {
  repo: string;
  number: number;
  headRef: string;
}

/** Everything the rules read besides the task itself, indexed by upper-case task id. */
export interface StageEvidence {
  openIds: ReadonlySet<string>;
  /** Open tasks naming each id in a `parent:` or `epic:` tag. */
  openChildren: ReadonlyMap<string, number>;
  openPrs: ReadonlyMap<string, readonly PrEvidence[]>;
  refs: ReadonlyMap<string, readonly RefEvidence[]>;
  /** Unix seconds of the newest `<ID>: …` commit on each repository's main line. */
  mergedAt: ReadonlyMap<string, number>;
}

const TASK_ID = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-\d+)(?![A-Za-z0-9])/g;

/** Task ids inside free text or a branch name, upper-cased; `pc-tp-1058-work` yields `TP-1058`. */
export function taskIdsIn(text: string): string[] {
  return [...text.matchAll(TASK_ID)].map((match) => match[1]!.toUpperCase());
}

const verdict = (stage: TaskStage, rule: StageRule, reason: string): StageVerdict => ({ stage, rule, reason, guessed: rule === "default" });

/** Rules in precedence order: done, review, in-progress, blocked, then ready with or without evidence. */
export function deriveStage(task: StagedTask, evidence: StageEvidence): StageVerdict {
  if (task.status === "done") return verdict("done", "status-done", "The task status is done");
  const pr = evidence.openPrs.get(task.id)?.[0];
  if (pr) return verdict("review", "open-pr", `PR ${pr.repo}#${pr.number} is open (head ${pr.headRef})`);
  const ref = liveRef(task.id, evidence);
  if (ref) return verdict("in-progress", "live-ref", `${ref.kind === "worktree" ? "Worktree on branch" : "Unmerged branch"} ${ref.name} in ${ref.repo}`);
  const blocked = blockedVerdict(task, evidence);
  if (blocked) return blocked;
  if (evidence.mergedAt.has(task.id)) return verdict("ready", "merged-commit", "PR merged; task still open");
  return verdict("ready", "default", "No pull request, live branch, worktree, open dependency or hold found");
}

/** A ref older than the task's newest merged commit is a leftover of that merge: squash merges never make it an ancestor of main. */
function liveRef(id: string, evidence: StageEvidence): RefEvidence | undefined {
  const merged = evidence.mergedAt.get(id) ?? -Infinity;
  const live = (evidence.refs.get(id) ?? []).filter((ref) => ref.tipAt > merged);
  return live.find((ref) => ref.kind === "worktree") ?? live[0];
}

function blockedVerdict(task: StagedTask, evidence: StageEvidence): StageVerdict | undefined {
  const notes = task.notes ?? "";
  const { open, unresolved } = dependenciesOf(task, notes, evidence.openIds);
  if (open.length > 0) return verdict("blocked", "dependency", `Depends on ${open.map((id) => `${id} (open)`).join(", ")}`);
  if (unresolved.length > 0) return verdict("blocked", "unresolved-dependency", `Unresolved dependency ${unresolved.join(", ")}`);
  const hold = holdOf(task.tags ?? [], notes);
  if (hold) return verdict("blocked", "hold", `Hold: ${hold}`);
  const children = evidence.openChildren.get(task.id) ?? 0;
  if (children > 0) return verdict("blocked", "open-slices", `${children} open ${children === 1 ? "slice" : "slices"}`);
  return undefined;
}

const DEPENDENCY_TAGS = ["dep:", "blocked-by:"];
// A clause ends at a sentence break; a bare period is not one, since slice labels such as P3.14 contain it.
const CLAUSE = /\b(depends(?:\s+on)?|blocked\s+by|waits?\s+on|after)\b(.*?)(?=[.!?;](?:\s|$)|\n|$)/gi;
const SLICE_LABEL = /(?<![A-Za-z0-9.-])([A-Z]{1,2}\d+(?:\.\d+)*[a-z]?)(?![A-Za-z0-9-])/g;

/**
 * `dep:` tags and ids named in dependency clauses, kept only while open. A `depends` clause that names slice labels
 * and no task id at all stays a blocker, since the label cannot be resolved here.
 */
function dependenciesOf(task: StagedTask, notes: string, openIds: ReadonlySet<string>): { open: string[]; unresolved: string[] } {
  const tagged = (task.tags ?? []).filter((tag) => DEPENDENCY_TAGS.some((prefix) => tag.startsWith(prefix))).flatMap((tag) => taskIdsIn(tag));
  const named: string[] = [];
  const unresolved: string[] = [];
  for (const [, keyword, span] of notes.matchAll(CLAUSE)) {
    const ids = taskIdsIn(span!);
    named.push(...ids);
    if (ids.length === 0 && /^depends/i.test(keyword!)) unresolved.push(...[...span!.matchAll(SLICE_LABEL)].map((match) => match[1]!));
  }
  const open = [...new Set([...tagged, ...named])].filter((id) => id !== task.id && openIds.has(id));
  return { open, unresolved: [...new Set(unresolved)] };
}

const HOLD_NOTE = /\bno dispatch\b|\bon hold\b|\bwaits? on the owner\b/i;

function holdOf(tags: readonly string[], notes: string): string | undefined {
  const tag = tags.find((entry) => entry.startsWith("hold:"));
  if (tag) return `tag ${tag}`;
  const note = HOLD_NOTE.exec(notes);
  return note ? `notes say "${note[0]}"` : undefined;
}
