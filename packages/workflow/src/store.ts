import { nowIso, quoteIdent, type Db, type Migration } from "@titan-design/store-sqlite";
import type { ActiveStep, StepResult, WorkflowRun, WorkflowStatus } from "./types.js";

export const DEFAULT_RUN_TABLE = "workflow_run";

export function workflowRunTableDdl(name: string = DEFAULT_RUN_TABLE): string {
  const t = quoteIdent(name);
  return `
    CREATE TABLE IF NOT EXISTS ${t} (
      id            TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      params        TEXT NOT NULL,
      status        TEXT NOT NULL,
      current_step  TEXT,
      step_results  TEXT NOT NULL DEFAULT '{}',
      active_steps  TEXT NOT NULL DEFAULT '{}',
      started_at    TEXT NOT NULL,
      completed_at  TEXT,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS ${quoteIdent(`${name}_status`)} ON ${t}(status);
  `;
}

/** Drop into a product's migration list so runs share its database. */
export function workflowMigration(version: number, name: string = DEFAULT_RUN_TABLE): Migration {
  return { version, name: `workflow:${name}`, up: (db) => db.exec(workflowRunTableDdl(name)) };
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
}

function toRun(raw: RawRunRow): WorkflowRun {
  return {
    id: raw.id,
    workflowName: raw.workflow_name,
    params: JSON.parse(raw.params) as Record<string, string>,
    status: raw.status,
    currentStep: raw.current_step,
    stepResults: JSON.parse(raw.step_results) as Record<string, StepResult>,
    activeSteps: JSON.parse(raw.active_steps) as Record<string, ActiveStep>,
    startedAt: raw.started_at,
    completedAt: raw.completed_at,
    error: raw.error,
  };
}

/** Persistence for runs. Every state transition writes the whole run; the row is the source of truth. */
export class WorkflowRunStore {
  private readonly upsertStmt;
  private readonly getStmt;
  private readonly byStatusStmt;

  constructor(db: Db, name: string = DEFAULT_RUN_TABLE) {
    const t = quoteIdent(name);
    this.upsertStmt = db.prepare(
      `INSERT INTO ${t} (id, workflow_name, params, status, current_step, step_results, active_steps, started_at, completed_at, error)
       VALUES (@id, @workflowName, @params, @status, @currentStep, @stepResults, @activeSteps, @startedAt, @completedAt, @error)
       ON CONFLICT (id) DO UPDATE SET params = excluded.params, status = excluded.status, current_step = excluded.current_step,
         step_results = excluded.step_results, active_steps = excluded.active_steps, completed_at = excluded.completed_at, error = excluded.error`,
    );
    this.getStmt = db.prepare(`SELECT * FROM ${t} WHERE id = ?`);
    this.byStatusStmt = db.prepare(`SELECT * FROM ${t} WHERE status IN (SELECT value FROM json_each(?)) ORDER BY started_at`);
  }

  save(run: WorkflowRun): void {
    this.upsertStmt.run({
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
    });
  }

  get(id: string): WorkflowRun | undefined {
    const raw = this.getStmt.get(id) as RawRunRow | undefined;
    return raw === undefined ? undefined : toRun(raw);
  }

  listByStatus(statuses: WorkflowStatus[]): WorkflowRun[] {
    return (this.byStatusStmt.all(JSON.stringify(statuses)) as RawRunRow[]).map(toRun);
  }
}

export function newRun(id: string, workflowName: string, params: Record<string, string>): WorkflowRun {
  return { id, workflowName, params: { ...params }, status: "running", currentStep: null, stepResults: {}, activeSteps: {}, startedAt: nowIso(), completedAt: null, error: null };
}
