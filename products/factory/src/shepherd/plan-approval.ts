import type { GateResolver } from "@titan-design/hitl";
import { CI_POLICY_KEYS } from "@titan-design/session-read";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

/** The merge-guard rows a plan-time answer may cover; every other row still asks the owner at merge. */
export const PLAN_APPROVAL_GATES = ["ci-policy", "skill", "visual"] as const;
export type PlanApprovalGate = (typeof PLAN_APPROVAL_GATES)[number];

const bounded = z.string().min(1).max(512);

/** One changed CI-policy line as the card's positional diff shows it: its file, side, 1-based line number there and text. */
const PlanApprovalEntrySchema = z.strictObject({ path: bounded, side: z.enum(["-", "+"]), n: z.number().int().positive(), text: z.string().max(512) });
export type PlanApprovalEntry = z.infer<typeof PlanApprovalEntrySchema>;

/** What the owner approved: exact paths, CI-policy keys, and each changed CI-policy line at its place. */
export const PlanApprovalScopeSchema = z.strictObject({
  paths: z.array(bounded).max(200),
  ciPolicyKeys: z.array(z.enum(CI_POLICY_KEYS)).max(CI_POLICY_KEYS.length).optional(),
  entries: z.array(PlanApprovalEntrySchema).max(200).optional(),
});
export type PlanApprovalScope = z.infer<typeof PlanApprovalScopeSchema>;

/** One owner answer as the merge guard reads it. */
export const PlanApprovalSchema = z.strictObject({ gate: z.enum(PLAN_APPROVAL_GATES), scope: PlanApprovalScopeSchema, round: bounded });
export type PlanApproval = z.infer<typeof PlanApprovalSchema>;

interface PlanApprovalInput extends PlanApproval {
  task: string;
  repo: string;
}

const PLAN_APPROVAL_DDL = `
  CREATE TABLE shepherd_plan_approval (
    confirm_event TEXT PRIMARY KEY,
    task          TEXT NOT NULL,
    repo          TEXT NOT NULL,
    gate          TEXT NOT NULL,
    scope         TEXT NOT NULL,
    round         TEXT NOT NULL,
    actor         TEXT NOT NULL,
    answered_at   TEXT NOT NULL
  );
  CREATE INDEX shepherd_plan_approval_task ON shepherd_plan_approval (task, repo);`;

/** The owner's plan-time answers, one row per console confirmation. */
export function planApprovalMigration(version = 46): Migration {
  return { version, name: "factory:shepherd_plan_approval", up: (db) => db.exec(PLAN_APPROVAL_DDL) };
}

/** The console's one identity (`consoleResolver`); a row any other actor wrote is never honoured. */
const CONSOLE_ACTOR = "owner-remote:titan-console";

export class PlanApprovalRefused extends Error {
  override readonly name = "PlanApprovalRefused";
}

export interface PlanApprovals {
  /** Writes one row per confirm event; false when this event already wrote its row. Refuses any resolver but the console's owner-remote. */
  record(input: PlanApprovalInput, resolver: GateResolver): boolean;
  /** The console-written approvals for the task in the repo, oldest first; a row that no longer parses reads as none. */
  forTask(task: string, repo: string): PlanApproval[];
}

const ApprovalRow = z.object({ gate: z.string(), scope: z.string(), round: z.string() });

export function planApprovalTable(db: Db, stamp: () => string): PlanApprovals {
  return {
    record: (input, resolver) => {
      const actor = `${resolver.class}:${resolver.id}`;
      if (actor !== CONSOLE_ACTOR || !resolver.confirmEvent) throw new PlanApprovalRefused(`a plan approval is the owner's own, written through the console; ${actor} may not write one`);
      const { gate, scope, round } = PlanApprovalSchema.parse({ gate: input.gate, scope: input.scope, round: input.round });
      const insert = "INSERT OR IGNORE INTO shepherd_plan_approval (confirm_event, task, repo, gate, scope, round, actor, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
      return db.prepare(insert).run(resolver.confirmEvent, input.task, input.repo.toLowerCase(), gate, JSON.stringify(scope), round, actor, stamp()).changes === 1;
    },
    forTask: (task, repo) => {
      const select = "SELECT gate, scope, round FROM shepherd_plan_approval WHERE task = ? AND repo = ? AND actor = ? ORDER BY answered_at, rowid";
      return db.prepare(select).all(task, repo.toLowerCase(), CONSOLE_ACTOR).flatMap((row) => parsedRow(row));
    },
  };
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
