import type { RepoSlug } from "@titan-design/github";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";
import { EffectivePolicySchema, type EffectivePolicy } from "./policy.js";

export const TASK_KINDS = ["correctness", "security", "feature", "refactor", "unknown"] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

/** A PR, or a branch whose PR does not exist yet, handed to one shepherd-pr run. */
export interface RegistrationInput {
  repo: RepoSlug;
  pr?: number;
  branch?: string;
  runId: string;
  task: string;
  implementer: string;
  reviewer?: string;
  policy: EffectivePolicy;
  /** Absent means `unknown`; a value outside `TASK_KINDS` is refused, because `unknown` skips the fix-proof gate. */
  kind?: string;
}

export interface Registration {
  repo: RepoSlug;
  pr: number | null;
  branch: string | null;
  runId: string;
  task: string;
  implementer: string;
  reviewer: string | null;
  policy: EffectivePolicy;
  kind: TaskKind;
  held: boolean;
  holdReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What the merge guard asks: the reason `repo#pr` is held, or undefined when nothing holds it. */
export interface HoldLookup {
  heldReason(repo: RepoSlug, pr: number): string | undefined;
}

const TABLE_DDL = `
  CREATE TABLE shepherd_registration (
    repo        TEXT NOT NULL,
    pr          INTEGER,
    branch      TEXT,
    run_id      TEXT NOT NULL UNIQUE,
    task        TEXT NOT NULL,
    implementer TEXT NOT NULL,
    reviewer    TEXT,
    policy      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    held        INTEGER NOT NULL DEFAULT 0,
    hold_reason TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    CHECK (pr IS NOT NULL OR branch IS NOT NULL)
  );
  CREATE UNIQUE INDEX shepherd_registration_pr ON shepherd_registration (repo, pr) WHERE pr IS NOT NULL;
  CREATE UNIQUE INDEX shepherd_registration_branch ON shepherd_registration (repo, branch);`;

export function shepherdMigration(version = 4): Migration {
  return { version, name: "factory:shepherd_registration", up: (db) => db.exec(TABLE_DDL) };
}

interface Row {
  repo: string;
  pr: number | null;
  branch: string | null;
  run_id: string;
  task: string;
  implementer: string;
  reviewer: string | null;
  policy: string;
  kind: string;
  held: number;
  hold_reason: string | null;
  created_at: string;
  updated_at: string;
}

const KindSchema = z.enum(TASK_KINDS);

/** GitHub treats repo names case-insensitively, so a hold on one spelling must hold every spelling. */
const repoKey = (repo: RepoSlug): string => repo.toLowerCase();

/** Shepherd registrations in the factory database; the table comes from `shepherdMigration`. */
export class ShepherdStore implements HoldLookup {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  register(input: RegistrationInput): Registration {
    if (input.pr === undefined && input.branch === undefined) throw new Error("a shepherd registration needs a pr or a branch");
    const kind = KindSchema.parse(input.kind ?? "unknown");
    const at = this.stamp();
    this.db
      .prepare(
        `INSERT INTO shepherd_registration (repo, pr, branch, run_id, task, implementer, reviewer, policy, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(repoKey(input.repo), input.pr ?? null, input.branch ?? null, input.runId, input.task, input.implementer, input.reviewer ?? null, JSON.stringify(input.policy), kind, at, at);
    return this.byRun(input.runId)!;
  }

  byRun(runId: string): Registration | undefined {
    return this.one("run_id = ?", runId);
  }

  byPr(repo: RepoSlug, pr: number): Registration | undefined {
    return this.one("repo = ? AND pr = ?", repoKey(repo), pr);
  }

  byBranch(repo: RepoSlug, branch: string): Registration | undefined {
    return this.one("repo = ? AND branch = ?", repoKey(repo), branch);
  }

  /** Record the PR a branch registration was waiting for; throws when the run has no registration. */
  setPr(runId: string, pr: number): Registration {
    const changed = this.db.prepare("UPDATE shepherd_registration SET pr = ?, updated_at = ? WHERE run_id = ?").run(pr, this.stamp(), runId).changes;
    if (changed === 0) throw new Error(`shepherd-pr run ${runId} has no registration`);
    return this.byRun(runId)!;
  }

  hold(runId: string, reason: string): Registration {
    return this.setHeld(runId, true, reason);
  }

  release(runId: string): Registration {
    return this.setHeld(runId, false, null);
  }

  heldReason(repo: RepoSlug, pr: number): string | undefined {
    const registration = this.byPr(repo, pr);
    return registration?.held ? (registration.holdReason ?? "held") : undefined;
  }

  private setHeld(runId: string, held: boolean, reason: string | null): Registration {
    const changed = this.db.prepare("UPDATE shepherd_registration SET held = ?, hold_reason = ?, updated_at = ? WHERE run_id = ?").run(held ? 1 : 0, reason, this.stamp(), runId).changes;
    if (changed === 0) throw new Error(`shepherd-pr run ${runId} has no registration`);
    return this.byRun(runId)!;
  }

  private one(where: string, ...args: unknown[]): Registration | undefined {
    const row = this.db.prepare(`SELECT * FROM shepherd_registration WHERE ${where}`).get(...args) as Row | undefined;
    return row && fromRow(row);
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function fromRow(row: Row): Registration {
  return {
    repo: row.repo,
    pr: row.pr,
    branch: row.branch,
    runId: row.run_id,
    task: row.task,
    implementer: row.implementer,
    reviewer: row.reviewer,
    policy: EffectivePolicySchema.parse(JSON.parse(row.policy)),
    kind: KindSchema.parse(row.kind),
    held: row.held === 1,
    holdReason: row.hold_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A store bound to whichever factory database the host opened; reading it unbound throws, so a merge guard fails closed. */
export interface ShepherdStoreRef {
  get(): ShepherdStore;
  /** Returns the unbind, which the host calls before it closes the database. */
  bind(db: Db): () => void;
}

export function shepherdStoreRef(now: () => number = Date.now): ShepherdStoreRef {
  let store: ShepherdStore | undefined;
  return {
    get() {
      if (!store) throw new Error("the shepherd store is not bound to an open factory database");
      return store;
    },
    bind(db) {
      if (store) throw new Error("the shepherd store is already bound to an open factory database");
      const bound = new ShepherdStore(db, now);
      store = bound;
      return () => void (store === bound && (store = undefined));
    },
  };
}
