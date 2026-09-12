import { hasColumn, nowIso, quoteIdent, type Db, type Migration } from "@titan-design/store-sqlite";
import type { ActiveStep, StepResult, WorkflowOwnerFence, WorkflowRun, WorkflowStatus } from "./types.js";

export const DEFAULT_RUN_TABLE = "workflow_run";

export function workflowRunTableDdl(name: string = DEFAULT_RUN_TABLE): string {
  const t = quoteIdent(name);
  return `
    CREATE TABLE IF NOT EXISTS ${t} (
      id                  TEXT PRIMARY KEY,
      workflow_name       TEXT NOT NULL,
      params              TEXT NOT NULL,
      status              TEXT NOT NULL,
      current_step        TEXT,
      step_results        TEXT NOT NULL DEFAULT '{}',
      active_steps        TEXT NOT NULL DEFAULT '{}',
      started_at          TEXT NOT NULL,
      completed_at        TEXT,
      error               TEXT,
      revision            INTEGER NOT NULL DEFAULT 0,
      owner_generation    INTEGER NOT NULL DEFAULT 0,
      owner_runtime_id    TEXT,
      owner_lease_until   TEXT
    );
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`${name}_status`)} ON ${t}(status);
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`${name}_owner_lease`)} ON ${t}(owner_lease_until);
  `;
}

/** Creates a fresh table. Existing deployments also add workflowOwnershipMigration once. */
export function workflowMigration(version: number, name: string = DEFAULT_RUN_TABLE): Migration {
  return { version, name: `workflow:${name}`, up: (db) => db.exec(workflowRunTableDdl(name)) };
}

/** Adds fencing columns when an earlier workflowMigration already created the table. */
export function workflowOwnershipMigration(version: number, name: string = DEFAULT_RUN_TABLE): Migration {
  return {
    version,
    name: `workflow-ownership:${name}`,
    up: (db) => {
      const t = quoteIdent(name);
      addColumn(db, name, "revision", `${t} ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`);
      addColumn(db, name, "owner_generation", `${t} ADD COLUMN owner_generation INTEGER NOT NULL DEFAULT 0`);
      addColumn(db, name, "owner_runtime_id", `${t} ADD COLUMN owner_runtime_id TEXT`);
      addColumn(db, name, "owner_lease_until", `${t} ADD COLUMN owner_lease_until TEXT`);
      db.exec(`CREATE INDEX IF NOT EXISTS ${quoteIdent(`${name}_owner_lease`)} ON ${t}(owner_lease_until)`);
    },
  };
}

export class WorkflowOwnershipLostError extends Error {
  constructor(readonly runId: string) {
    super(`workflow ownership lost for ${runId}`);
    this.name = "WorkflowOwnershipLostError";
  }
}

interface RawRunRow {
  id: string;
  workflow_name: string;
  params: string;
  status: WorkflowStatus;
  current_step: string | null;
  step_results: string;
  active_steps: string;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  revision: number;
  owner_generation: number;
  owner_runtime_id: string | null;
  owner_lease_until: string | null;
}

/** Durable workflow rows with independent runtime ownership and revision fencing. */
export class WorkflowRunStore {
  private readonly table: string;

  constructor(private readonly db: Db, name: string = DEFAULT_RUN_TABLE) {
    this.table = quoteIdent(name);
  }

  create(run: WorkflowRun): void {
    this.db.prepare(
      `INSERT INTO ${this.table}
       (id, workflow_name, params, status, current_step, step_results, active_steps, started_at, completed_at, error,
        revision, owner_generation, owner_runtime_id, owner_lease_until)
       VALUES (@id, @workflowName, @params, @status, @currentStep, @stepResults, @activeSteps, @startedAt, @completedAt,
        @error, @revision, @ownerGeneration, NULL, NULL)`,
    ).run(columns(run));
  }

  get(id: string): WorkflowRun | undefined {
    const raw = this.db.prepare(`SELECT * FROM ${this.table} WHERE id = ?`).get(id) as RawRunRow | undefined;
    return raw ? toRun(raw) : undefined;
  }

  listByStatus(statuses: WorkflowStatus[]): WorkflowRun[] {
    const rows = this.db.prepare(
      `SELECT * FROM ${this.table} WHERE status IN (SELECT value FROM json_each(?)) ORDER BY started_at`,
    ).all(JSON.stringify(statuses)) as RawRunRow[];
    return rows.map(toRun);
  }

  claim(id: string, runtimeId: string, leaseUntil: string, at: string): WorkflowRun | undefined {
    if (!runtimeId.trim()) throw new TypeError("runtimeId must not be empty");
    const timestamps = leaseTimestamps(leaseUntil, at);
    const result = this.db.prepare(
      `UPDATE ${this.table}
       SET owner_runtime_id = ?, owner_generation = owner_generation + 1, owner_lease_until = ?, revision = revision + 1
       WHERE id = ? AND status IN ('running', 'paused', 'cancelling', 'recovery_required')
         AND (owner_runtime_id IS NULL OR owner_lease_until <= ?)`,
    ).run(runtimeId, timestamps.leaseUntil, id, timestamps.at);
    return result.changes === 1 ? this.get(id) : undefined;
  }

  save(run: WorkflowRun, fence: WorkflowOwnerFence, leaseUntil: string, at: string): void {
    const timestamps = leaseTimestamps(leaseUntil, at);
    const nextRevision = run.revision + 1;
    const result = this.db.prepare(
      `UPDATE ${this.table}
       SET params = @params, status = @status, current_step = @currentStep, step_results = @stepResults,
           active_steps = @activeSteps, completed_at = @completedAt, error = @error,
           revision = @nextRevision, owner_lease_until = @leaseUntil
       WHERE id = @id AND revision = @revision AND owner_runtime_id = @runtimeId
         AND owner_generation = @generation AND owner_lease_until > @at`,
    ).run({ ...columns(run), ...fence, nextRevision, ...timestamps });
    if (result.changes !== 1) throw new WorkflowOwnershipLostError(run.id);
    run.revision = nextRevision;
    run.owner = { ...fence, leaseUntil: timestamps.leaseUntil };
  }

  renew(run: WorkflowRun, fence: WorkflowOwnerFence, leaseUntil: string, at: string): void {
    const timestamps = leaseTimestamps(leaseUntil, at);
    const nextRevision = run.revision + 1;
    const result = this.db.prepare(
      `UPDATE ${this.table} SET revision = ?, owner_lease_until = ?
       WHERE id = ? AND revision = ? AND owner_runtime_id = ? AND owner_generation = ? AND owner_lease_until > ?`,
    ).run(nextRevision, timestamps.leaseUntil, run.id, run.revision, fence.runtimeId, fence.generation, timestamps.at);
    if (result.changes !== 1) throw new WorkflowOwnershipLostError(run.id);
    run.revision = nextRevision;
    run.owner = { ...fence, leaseUntil: timestamps.leaseUntil };
  }

  release(run: WorkflowRun, fence: WorkflowOwnerFence): void {
    const nextRevision = run.revision + 1;
    const result = this.db.prepare(
      `UPDATE ${this.table} SET revision = ?, owner_runtime_id = NULL, owner_lease_until = NULL
       WHERE id = ? AND revision = ? AND owner_runtime_id = ? AND owner_generation = ?`,
    ).run(nextRevision, run.id, run.revision, fence.runtimeId, fence.generation);
    if (result.changes !== 1) throw new WorkflowOwnershipLostError(run.id);
    run.revision = nextRevision;
    run.owner = undefined;
  }
}

export function newRun(id: string, workflowName: string, params: Record<string, string>): WorkflowRun {
  return {
    id,
    workflowName,
    params: { ...params },
    status: "running",
    currentStep: null,
    stepResults: {},
    activeSteps: {},
    revision: 0,
    ownerGeneration: 0,
    startedAt: nowIso(),
    completedAt: null,
    error: null,
  };
}

function toRun(raw: RawRunRow): WorkflowRun {
  const active = JSON.parse(raw.active_steps) as Record<string, Partial<ActiveStep> & Pick<ActiveStep, "stepId" | "iterKey" | "startedAt">>;
  return {
    id: raw.id,
    workflowName: raw.workflow_name,
    params: JSON.parse(raw.params) as Record<string, string>,
    status: raw.status,
    currentStep: raw.current_step,
    stepResults: JSON.parse(raw.step_results) as Record<string, StepResult>,
    activeSteps: Object.fromEntries(Object.entries(active).map(([key, step]) => [key, normalizeActiveStep(step)])),
    revision: raw.revision,
    ownerGeneration: raw.owner_generation,
    ...(raw.owner_runtime_id && raw.owner_lease_until
      ? { owner: { runtimeId: raw.owner_runtime_id, generation: raw.owner_generation, leaseUntil: raw.owner_lease_until } }
      : {}),
    startedAt: raw.started_at,
    completedAt: raw.completed_at,
    error: raw.error,
  };
}

function normalizeActiveStep(step: Partial<ActiveStep> & Pick<ActiveStep, "stepId" | "iterKey" | "startedAt">): ActiveStep {
  if (step.kind === "recoverable" && typeof step.executionId === "string" && typeof step.requestKey === "string") {
    return { ...step, kind: "recoverable", executionId: step.executionId, requestKey: step.requestKey, attempt: step.attempt ?? 0 };
  }
  return { ...step, kind: "legacy", attempt: step.attempt ?? 0 };
}

function columns(run: WorkflowRun) {
  return {
    id: run.id,
    workflowName: run.workflowName,
    params: JSON.stringify(run.params),
    status: run.status,
    currentStep: run.currentStep,
    stepResults: JSON.stringify(run.stepResults),
    activeSteps: JSON.stringify(run.activeSteps),
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    revision: run.revision,
    ownerGeneration: run.ownerGeneration,
  };
}

function addColumn(db: Db, table: string, column: string, clause: string): void {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${clause}`);
}

function leaseTimestamps(leaseUntil: string, at: string): { leaseUntil: string; at: string } {
  const normalized = { leaseUntil: timestamp(leaseUntil, "leaseUntil"), at: timestamp(at, "at") };
  if (normalized.leaseUntil <= normalized.at) throw new RangeError("leaseUntil must be later than at");
  return normalized;
}

function timestamp(value: string, name: string): string {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${name} must be a valid timestamp`);
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    throw new TypeError(`${name} must be a valid timestamp`);
  }
}
