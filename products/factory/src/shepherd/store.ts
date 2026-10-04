import type { RepoSlug } from "@titan-design/github";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";
import { EffectivePolicySchema, RegistrationRefused, stricterPolicy, type EffectivePolicy } from "./policy.js";

export const TASK_KINDS = ["correctness", "security", "feature", "refactor", "unknown"] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

const FIX_PROOF_KINDS: ReadonlySet<TaskKind> = new Set(["correctness", "security"]);

/** The kinds a fix PR is held to the fix-proof gate for; every other kind, `unknown` included, skips it. */
function requiresFixProof(kind: TaskKind): boolean {
  return FIX_PROOF_KINDS.has(kind);
}

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
  /** Names the slice of a multi-slice task this PR delivers; landing then notes the task instead of closing it. */
  slice?: string;
}

export type RegistrationUpdate = Pick<RegistrationInput, "task" | "implementer" | "reviewer" | "policy" | "kind" | "slice">;

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
  slice: string | null;
  held: boolean;
  holdReason: string | null;
  /** The reviewer a hold waits on, set only by `hold --reviewer`; never read out of the reason. */
  holdReviewer: string | null;
  /** The head at which the hold's reviewer sent MERGE, and who sent it; a merge at that head passes the hold. */
  holdSatisfied: HoldSatisfaction | null;
  /** A Version Packages PR's head that passed the release preflight under an auto policy, and when; other merges in the repo wait on it. */
  releaseReady: { head: string; at: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** The verdict that satisfied a hold: its reviewer's name, the session that wrote it, and where in that session's transcript. */
export const HoldSatisfiedBySchema = z.object({ reviewer: z.string(), agentId: z.string(), sessionId: z.string(), locator: z.looseObject({}) });
export type HoldSatisfiedBy = z.infer<typeof HoldSatisfiedBySchema>;

export interface HoldSatisfaction {
  head: string;
  by: HoldSatisfiedBy;
}

/** What the merge guard asks: the reason `repo#pr`, or the PR's head `branch`, is held, or undefined when nothing holds it; a hold satisfied at `sha` does not hold a merge there. */
export interface HoldLookup {
  heldReason(repo: RepoSlug, pr: number, branch?: string, sha?: string): string | undefined;
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

export function sliceMigration(version = 8): Migration {
  return { version, name: "factory:shepherd_registration_slice", up: (db) => db.exec("ALTER TABLE shepherd_registration ADD COLUMN slice TEXT") };
}

const TP734_DDL = `
  ALTER TABLE shepherd_registration ADD COLUMN hold_reviewer TEXT;
  ALTER TABLE shepherd_registration ADD COLUMN release_ready_head TEXT;
  ALTER TABLE shepherd_registration ADD COLUMN release_ready_at TEXT;`;

/** The hold's structured reviewer, and the head at which a Version Packages PR passed its release preflight. */
export function holdReviewerMigration(version = 9): Migration {
  return { version, name: "factory:shepherd_registration_hold_reviewer_release_ready", up: (db) => db.exec(TP734_DDL) };
}

const TP779_DDL = `
  ALTER TABLE shepherd_registration ADD COLUMN hold_satisfied_head TEXT;
  ALTER TABLE shepherd_registration ADD COLUMN hold_satisfied_by TEXT;`;

/** The head at which a hold's named reviewer sent MERGE, and the verdict's author and locator. */
export function holdSatisfiedMigration(version = 11): Migration {
  return { version, name: "factory:shepherd_registration_hold_satisfied", up: (db) => db.exec(TP779_DDL) };
}

export const AUTHOR_ROLES = ["implementer", "successor"] as const;

export type AuthorRole = (typeof AUTHOR_ROLES)[number];

/** An agent that wrote a run's code: the implementer, or a successor that took the work over from `predecessor`. */
export interface AuthorInput {
  agentId: string;
  name: string;
  role: AuthorRole;
  predecessor?: string;
}

export interface Author {
  runId: string;
  agentId: string;
  name: string;
  role: AuthorRole;
  predecessor: string | null;
  at: string;
}

const LINEAGE_DDL = `
  CREATE TABLE shepherd_lineage (
    run_id      TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('implementer', 'successor')),
    predecessor TEXT,
    at          TEXT NOT NULL,
    PRIMARY KEY (run_id, agent_id)
  );`;

export function lineageMigration(version = 5): Migration {
  return { version, name: "factory:shepherd_lineage", up: (db) => db.exec(LINEAGE_DDL) };
}

interface AuthorRow {
  run_id: string;
  agent_id: string;
  name: string;
  role: AuthorRole;
  predecessor: string | null;
  at: string;
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
  slice: string | null;
  held: number;
  hold_reason: string | null;
  hold_reviewer?: string | null;
  release_ready_head?: string | null;
  release_ready_at?: string | null;
  hold_satisfied_head?: string | null;
  hold_satisfied_by?: string | null;
  created_at: string;
  updated_at: string;
}

const KindSchema = z.enum(TASK_KINDS);

/** GitHub treats repo names case-insensitively, so a hold on one spelling must hold every spelling. */
const repoKey = (repo: RepoSlug): string => repo.toLowerCase();

const REFS_HEADS = "refs/heads/";

/** A branch spelled `refs/heads/<b>` and one spelled `<b>` are the same branch; strip one leading prefix. */
const branchName = (branch: string): string => (branch.startsWith(REFS_HEADS) ? branch.slice(REFS_HEADS.length) : branch);

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
        `INSERT INTO shepherd_registration (repo, pr, branch, run_id, task, implementer, reviewer, policy, kind, slice, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(repoKey(input.repo), input.pr ?? null, input.branch === undefined ? null : branchName(input.branch), input.runId, input.task, input.implementer, input.reviewer ?? null, JSON.stringify(input.policy), kind, input.slice ?? null, at, at);
    return this.byRun(input.runId)!;
  }

  byRun(runId: string): Registration | undefined {
    return this.one("run_id = ?", runId);
  }

  byPr(repo: RepoSlug, pr: number): Registration | undefined {
    return this.one("repo = ? AND pr = ?", repoKey(repo), pr);
  }

  byBranch(repo: RepoSlug, branch: string): Registration | undefined {
    const name = branchName(branch);
    return this.one("repo = ? AND (branch = ? OR branch = ?)", repoKey(repo), name, `${REFS_HEADS}${name}`);
  }

  /** Every registration, oldest first. */
  all(): Registration[] {
    const rows = this.db.prepare("SELECT * FROM shepherd_registration ORDER BY created_at, rowid").all() as Row[];
    return rows.map(fromRow);
  }

  /**
   * A repeat registration refreshes who and what the run is for; its merge mode and fixer only narrow the stored policy.
   * An omitted kind keeps the stored one, so a repeat without `--kind` cannot drop a run out of the fix-proof gate.
   * An explicit kind that would move a gated run to a kind that skips the gate is refused.
   */
  update(runId: string, meta: RegistrationUpdate): Registration {
    const explicitKind = meta.kind === undefined ? undefined : KindSchema.parse(meta.kind);
    const write = this.db.transaction(() => {
      const stored = this.byRun(runId);
      if (!stored) throw new Error(`shepherd-pr run ${runId} has no registration`);
      const policy = stricterPolicy(meta.policy, stored.policy);
      const kind = explicitKind ?? stored.kind;
      if (requiresFixProof(stored.kind) && !requiresFixProof(kind)) {
        throw new RegistrationRefused(`run ${runId} is kind ${stored.kind}, which requires the fix-proof gate; kind ${kind} skips it`);
      }
      this.db
        .prepare("UPDATE shepherd_registration SET task = ?, implementer = ?, reviewer = ?, policy = ?, kind = ?, slice = ?, updated_at = ? WHERE run_id = ?")
        .run(meta.task, meta.implementer, meta.reviewer ?? null, JSON.stringify(policy), kind, meta.slice ?? null, this.stamp(), runId);
    });
    write.immediate();
    return this.byRun(runId)!;
  }

  /** Record the PR a branch registration was waiting for; throws when the run has no registration. */
  setPr(runId: string, pr: number): Registration {
    const changed = this.db.prepare("UPDATE shepherd_registration SET pr = ?, updated_at = ? WHERE run_id = ?").run(pr, this.stamp(), runId).changes;
    if (changed === 0) throw new Error(`shepherd-pr run ${runId} has no registration`);
    return this.byRun(runId)!;
  }

  /** Points a registration, and the authors recorded for its run, at the run that replaces its failed one; the old run stays in the workflow database. */
  repoint(runId: string, newRunId: string): Registration {
    const move = this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE shepherd_registration SET run_id = ?, updated_at = ? WHERE run_id = ?").run(newRunId, this.stamp(), runId).changes;
      if (changed === 0) throw new Error(`shepherd-pr run ${runId} has no registration`);
      this.db.prepare("UPDATE shepherd_lineage SET run_id = ? WHERE run_id = ?").run(newRunId, runId);
    });
    move();
    return this.byRun(newRunId)!;
  }

  /** A hold or a release clears any satisfaction, so a re-hold waits for its own reviewer again. */
  hold(runId: string, reason: string, reviewer?: string): Registration {
    return this.setHeld(runId, true, reason, reviewer ?? null);
  }

  release(runId: string): Registration {
    return this.setHeld(runId, false, null, null);
  }

  /** Compare-and-swap: records the MERGE only while the run is still held for `reviewer`; false when a release or re-hold got there first. */
  satisfyHold(runId: string, reviewer: string, head: string, by: Omit<HoldSatisfiedBy, "reviewer">): boolean {
    const satisfiedBy = JSON.stringify(HoldSatisfiedBySchema.parse({ ...by, reviewer }));
    const changed = this.db
      .prepare("UPDATE shepherd_registration SET hold_satisfied_head = ?, hold_satisfied_by = ?, updated_at = ? WHERE run_id = ? AND held = 1 AND hold_reviewer = ?")
      .run(head, satisfiedBy, this.stamp(), runId, reviewer).changes;
    return changed === 1;
  }

  /** Withdraws the satisfaction, as when the reviewer's newest verdict is FIX_FIRST; at whatever head it was read, so no later carry can restore it. */
  unsatisfyHold(runId: string): void {
    this.db.prepare("UPDATE shepherd_registration SET hold_satisfied_head = NULL, hold_satisfied_by = NULL, updated_at = ? WHERE run_id = ?").run(this.stamp(), runId);
  }

  /** Marks `head` as ready to land, or clears the mark with null. */
  setReleaseReady(runId: string, head: string | null): void {
    const changed = this.db
      .prepare("UPDATE shepherd_registration SET release_ready_head = ?, release_ready_at = ?, updated_at = ? WHERE run_id = ?")
      .run(head, head === null ? null : this.stamp(), this.stamp(), runId).changes;
    if (changed === 0) throw new Error(`shepherd-pr run ${runId} has no registration`);
  }

  /** Gives up a finished run's claim on its branch, so a later PR from the same branch can register. */
  releaseBranch(runId: string): void {
    this.db.prepare("UPDATE shepherd_registration SET branch = NULL, updated_at = ? WHERE run_id = ? AND pr IS NOT NULL").run(this.stamp(), runId);
  }

  /** A branch registration still waiting for its PR holds that PR too, so no merge slips in before `setPr`. */
  heldReason(repo: RepoSlug, pr: number, branch?: string, sha?: string): string | undefined {
    const candidates = [this.byPr(repo, pr), branch === undefined ? undefined : this.byBranch(repo, branch)];
    const held = candidates.find((registration) => registration?.held && !(sha !== undefined && registration.holdSatisfied?.head === sha));
    return held && (held.holdReason ?? "held");
  }

  /** Records an author of the run's code; a repeat for the same agent keeps the first row, so lineage never rewrites itself. */
  recordAuthor(runId: string, agent: AuthorInput): void {
    this.db
      .prepare("INSERT INTO shepherd_lineage (run_id, agent_id, name, role, predecessor, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (run_id, agent_id) DO NOTHING")
      .run(runId, agent.agentId, agent.name, agent.role, agent.predecessor ?? null, this.stamp());
  }

  /** Every author recorded for the run, earliest first, ties broken by agent id. */
  authorsOf(runId: string): Author[] {
    const rows = this.db.prepare("SELECT * FROM shepherd_lineage WHERE run_id = ? ORDER BY at, agent_id").all(runId) as AuthorRow[];
    return rows.map((row) => ({ runId: row.run_id, agentId: row.agent_id, name: row.name, role: row.role, predecessor: row.predecessor, at: row.at }));
  }

  private setHeld(runId: string, held: boolean, reason: string | null, reviewer: string | null): Registration {
    const changed = this.db
      .prepare("UPDATE shepherd_registration SET held = ?, hold_reason = ?, hold_reviewer = ?, hold_satisfied_head = NULL, hold_satisfied_by = NULL, updated_at = ? WHERE run_id = ?")
      .run(held ? 1 : 0, reason, reviewer, this.stamp(), runId).changes;
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
    slice: row.slice,
    held: row.held === 1,
    holdReason: row.hold_reason,
    holdReviewer: row.hold_reviewer ?? null,
    holdSatisfied: row.hold_satisfied_head && row.hold_satisfied_by ? { head: row.hold_satisfied_head, by: HoldSatisfiedBySchema.parse(JSON.parse(row.hold_satisfied_by)) } : null,
    releaseReady: row.release_ready_head && row.release_ready_at ? { head: row.release_ready_head, at: row.release_ready_at } : null,
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
