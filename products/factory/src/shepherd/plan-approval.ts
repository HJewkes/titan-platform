import type { GateResolver } from "@titan-design/hitl";
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

/** What the owner approved for a skill or visual PR: exact paths, compared as written. */
export const PathScopeSchema = z.strictObject({ paths: z.array(bounded).min(1).max(200) });

/** One owner answer as a reader gets it back; the scope's shape follows the gate, one of the merge-guard rows a plan may name. */
export const PlanApprovalSchema = z.discriminatedUnion("gate", [
  z.strictObject({ gate: z.literal("ci-policy"), scope: CiPolicyScopeSchema, round: bounded }),
  z.strictObject({ gate: z.enum(["skill", "visual"]), scope: PathScopeSchema, round: bounded }),
]);
export type PlanApproval = z.infer<typeof PlanApprovalSchema>;

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
   * Writes one row per confirm event, claimed by `claimRun` when given; false when this event already wrote its row.
   * Refuses any resolver but the console's owner-remote.
   */
  record(input: PlanApprovalInput, resolver: GateResolver, claimRun?: string): boolean;
  /** The console-written approvals of `task` in `repo` that `runId` claimed, oldest first; a row that no longer parses reads as none. */
  forRun(runId: string, task: string, repo: string): PlanApproval[];
}

const ApprovalRow = z.object({ gate: z.string(), scope: z.string(), round: z.string() });

export function planApprovalTable(db: Db, stamp: () => string): PlanApprovals {
  return {
    record: (input, resolver, claimRun) => {
      const actor = `${resolver.class}:${resolver.id}`;
      if (actor !== CONSOLE_ACTOR || !resolver.confirmEvent) throw new PlanApprovalRefused(`a plan approval is the owner's own, written through the console; ${actor} may not write one`);
      const { gate, scope, round } = PlanApprovalSchema.parse({ gate: input.gate, scope: input.scope, round: input.round });
      const insert = "INSERT OR IGNORE INTO shepherd_plan_approval (confirm_event, task, repo, gate, scope, round, actor, claimed_run, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
      return db.prepare(insert).run(resolver.confirmEvent, input.task, input.repo.toLowerCase(), gate, JSON.stringify(scope), round, actor, claimRun ?? null, stamp()).changes === 1;
    },
    forRun: (runId, task, repo) => {
      const select = "SELECT gate, scope, round FROM shepherd_plan_approval WHERE claimed_run = ? AND task = ? AND repo = ? AND actor = ? ORDER BY answered_at, rowid";
      return db.prepare(select).all(runId, task, repo.toLowerCase(), CONSOLE_ACTOR).flatMap((row) => parsedRow(row));
    },
  };
}

/** A new registration claims every approval of its task that no run has claimed yet; called inside the registration's INSERT transaction. */
export function claimPlanApprovals(db: Db, runId: string, task: string, repo: string): void {
  if (!hasApprovalTable(db)) return;
  db.prepare("UPDATE shepherd_plan_approval SET claimed_run = ? WHERE claimed_run IS NULL AND task = ? AND repo = ?").run(runId, task, repo.toLowerCase());
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
