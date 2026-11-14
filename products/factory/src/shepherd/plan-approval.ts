import type { GateResolver } from "@titan-design/hitl";
import { promptLine } from "@titan-design/owner-queue";
import { CI_POLICY_KEYS } from "@titan-design/session-read";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

const bounded = z.string().min(1).max(512);

/** One file a CI-policy PR changes, pinned to its git blob sha at head; null means the file is absent at head. */
const PinnedFileSchema = z.strictObject({ path: bounded, blob: z.string().regex(/^[0-9a-f]{40}$/).nullable() });

/** What the owner approved for a CI-policy PR: the keys it was told the PR weakens and the exact content of each file it changes. */
export const CiPolicyScopeSchema = z.strictObject({
  ciPolicyKeys: z.array(z.enum(CI_POLICY_KEYS)).min(1).max(CI_POLICY_KEYS.length),
  files: z
    .array(PinnedFileSchema)
    .min(1)
    .max(20)
    .refine((files) => new Set(files.map((file) => file.path)).size === files.length, "each pinned path appears once"),
});
export type CiPolicyScope = z.infer<typeof CiPolicyScopeSchema>;

/** What the owner approved for a skill or visual PR: exact paths, compared as written. */
export const PathScopeSchema = z.strictObject({ paths: z.array(bounded).min(1).max(200) });

/** Owner rule Q4: the only reasons a task needs the owner's own validation before it is worked. */
export const TASK_APPROVAL_REASONS = ["new-direction", "one-way-door", "new-cap", "authority-widening"] as const;

/** The canonical `<initiative>/<ID>` key; a bare ID or any other shape is refused, never resolved. */
export const TaskKeySchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Z][A-Z0-9]*-[0-9]+$/, "a task key is <initiative>/<ID>");

/** A done_when as the owner reads and the row binds it: trimmed, every whitespace run one space. */
export const collapsedDoneWhen = (doneWhen: string): string => doneWhen.trim().replace(/\s+/g, " ");

const LONE_SURROGATE = /[\u{d800}-\u{dfff}]/u;

/** True when the owner's screen would show `doneWhen` exactly as the row binds it: collapsed, with nothing a prompt strips. */
export const isShownAsBound = (doneWhen: string): boolean =>
  collapsedDoneWhen(doneWhen) === doneWhen && promptLine(doneWhen) === doneWhen && !LONE_SURROGATE.test(doneWhen);

/**
 * What the owner validated for a task: the done_when text itself, which the console shows in the scope card and the row
 * keeps, so the approval binds exactly what they read and a reader compares the whole text, never a short digest of it.
 */
export const TaskScopeSchema = z.strictObject({
  doneWhen: z.string().min(1).max(4000).refine(isShownAsBound, "a done_when is collapsed whitespace with no escape, invisible or control characters"),
  reason: z.enum(TASK_APPROVAL_REASONS),
  visualSignoff: z.boolean(),
});
export type TaskScope = z.infer<typeof TaskScopeSchema>;

/** One owner answer as a reader gets it back; the scope's shape follows the gate, a merge-guard row a plan may name or the task itself. */
export const PlanApprovalSchema = z.discriminatedUnion("gate", [
  z.strictObject({ gate: z.literal("ci-policy"), scope: CiPolicyScopeSchema, round: bounded }),
  z.strictObject({ gate: z.enum(["skill", "visual"]), scope: PathScopeSchema, round: bounded }),
  z.strictObject({ gate: z.literal("task"), scope: TaskScopeSchema, round: bounded }),
]);
export type PlanApproval = z.infer<typeof PlanApprovalSchema>;
export type TaskApproval = Extract<PlanApproval, { gate: "task" }>;

type PlanApprovalInput = PlanApproval & { task: string; repo: string };

const PLAN_APPROVAL_DDL = `
  CREATE TABLE shepherd_plan_approval (
    confirm_event TEXT PRIMARY KEY,
    task          TEXT NOT NULL,
    repo          TEXT NOT NULL,
    gate          TEXT NOT NULL,
    scope         TEXT NOT NULL,
    round         TEXT NOT NULL,
    actor         TEXT NOT NULL,
    claimed_run   TEXT,
    answered_at   TEXT NOT NULL
  );
  CREATE INDEX shepherd_plan_approval_task ON shepherd_plan_approval (task, repo);
  CREATE INDEX shepherd_plan_approval_run ON shepherd_plan_approval (claimed_run);`;

/** The owner's plan-time answers, one row per console confirmation, each claimed by at most one run. */
export function planApprovalMigration(version = 46): Migration {
  return { version, name: "factory:shepherd_plan_approval", up: (db) => db.exec(PLAN_APPROVAL_DDL) };
}

/** The console's one identity (`consoleResolver`); a row any other actor wrote is never read back. */
const CONSOLE_ACTOR = "owner-remote:titan-console";

export class PlanApprovalRefused extends Error {
  override readonly name = "PlanApprovalRefused";
}

export interface PlanApprovals {
  /**
   * Writes one row per confirm event, claimed by `claimRun` when given and never for a `task` row; false when this event already wrote its row.
   * Refuses any resolver but the console's owner-remote.
   */
  record(input: PlanApprovalInput, resolver: GateResolver, claimRun?: string): boolean;
  /** The console-written approvals of `task` in `repo` that `runId` claimed, oldest first; a row that no longer parses reads as none. */
  forRun(runId: string, task: string, repo: string): PlanApproval[];
  /** The latest console-written `task` row for `taskKey`, in any repo and claimed by no run; only owner-task-approval.ts reads it. */
  forTask(taskKey: string): TaskApproval | undefined;
}

const ApprovalRow = z.object({ gate: z.string(), scope: z.string(), round: z.string() });

export function planApprovalTable(db: Db, stamp: () => string): PlanApprovals {
  return {
    record: (input, resolver, claimRun) => {
      const actor = `${resolver.class}:${resolver.id}`;
      if (actor !== CONSOLE_ACTOR || !resolver.confirmEvent) throw new PlanApprovalRefused(`a plan approval is the owner's own, written through the console; ${actor} may not write one`);
      const { gate, scope, round } = PlanApprovalSchema.parse({ gate: input.gate, scope: input.scope, round: input.round });
      if (gate === "task" && !TaskKeySchema.safeParse(input.task).success) throw new PlanApprovalRefused(`a task approval is keyed by <initiative>/<ID>; ${JSON.stringify(input.task)} is not one`);
      const claimed = gate === "task" ? null : (claimRun ?? null);
      const insert = "INSERT OR IGNORE INTO shepherd_plan_approval (confirm_event, task, repo, gate, scope, round, actor, claimed_run, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
      return db.prepare(insert).run(resolver.confirmEvent, input.task, input.repo.toLowerCase(), gate, JSON.stringify(scope), round, actor, claimed, stamp()).changes === 1;
    },
    forRun: (runId, task, repo) => {
      const select = "SELECT gate, scope, round FROM shepherd_plan_approval WHERE claimed_run = ? AND task = ? AND repo = ? AND actor = ? AND gate != 'task' ORDER BY answered_at, rowid";
      return db.prepare(select).all(runId, task, repo.toLowerCase(), CONSOLE_ACTOR).flatMap((row) => parsedRow(row));
    },
    forTask: (taskKey) => {
      const select = "SELECT gate, scope, round FROM shepherd_plan_approval WHERE task = ? AND gate = 'task' AND actor = ? ORDER BY answered_at DESC, rowid DESC LIMIT 1";
      const [latest] = parsedRow(db.prepare(select).get(taskKey, CONSOLE_ACTOR));
      return latest?.gate === "task" ? latest : undefined;
    },
  };
}

/**
 * A new registration claims every approval of its task that no run has claimed yet; called inside the registration's INSERT
 * transaction. A `task` approval covers every PR of the task, so no run takes it.
 */
export function claimPlanApprovals(db: Db, runId: string, task: string, repo: string): void {
  if (!hasApprovalTable(db)) return;
  db.prepare("UPDATE shepherd_plan_approval SET claimed_run = ? WHERE claimed_run IS NULL AND task = ? AND repo = ? AND gate != 'task'").run(runId, task, repo.toLowerCase());
}

/** A replacement run takes over its failed run's claims, as it takes over the registration. */
export function repointPlanApprovals(db: Db, runId: string, newRunId: string): void {
  if (!hasApprovalTable(db)) return;
  db.prepare("UPDATE shepherd_plan_approval SET claimed_run = ? WHERE claimed_run = ?").run(newRunId, runId);
}

/** A store opened without this migration holds no approvals, so a registration in it has nothing to claim. */
function hasApprovalTable(db: Db): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shepherd_plan_approval'").get() !== undefined;
}

function parsedRow(raw: unknown): PlanApproval[] {
  const row = ApprovalRow.safeParse(raw);
  if (!row.success) return [];
  try {
    const parsed = PlanApprovalSchema.safeParse({ ...row.data, scope: JSON.parse(row.data.scope) });
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
  }
}
