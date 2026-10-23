import type { Db, Migration } from "@titan-design/store-sqlite";
import type { WorkflowRun, WorkflowRuntime } from "@titan-design/workflow";
import { z } from "zod";
import { NO_USAGE, StageRecordSchema, type StageRecord } from "./records.js";
import { readJson, runPaths } from "./run-dir.js";
import type { StageSpec } from "./stage-spec.js";

export const stageRunsMigration = (version: number): Migration => ({
  version,
  name: "explainer-stage-runs",
  up: (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS explainer_stage_runs (
      key TEXT PRIMARY KEY, stage TEXT NOT NULL, sample INTEGER NOT NULL, child_run_id TEXT NOT NULL, status TEXT NOT NULL,
      outputs TEXT, record TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  },
});

const StageRunRowSchema = z.object({
  key: z.string(),
  stage: z.string(),
  sample: z.number(),
  child_run_id: z.string(),
  status: z.enum(["running", "completed", "failed"]),
  record: z.string().nullable(),
});
export type StageRunRow = z.infer<typeof StageRunRowSchema>;

/** `explainer_stage_runs`: one row per stage key, naming the child run that holds (or is making) its outputs. */
export class StageRunStore {
  constructor(private readonly db: Db) {}

  get(key: string): StageRunRow | undefined {
    return StageRunRowSchema.optional().parse(this.db.prepare("SELECT key, stage, sample, child_run_id, status, record FROM explainer_stage_runs WHERE key = ?").get(key));
  }

  /** A failed key's row is replaced, so the next attempt's child is the one the key names. */
  started(spec: StageSpec, childRunId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO explainer_stage_runs (key, stage, sample, child_run_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)
      ON CONFLICT(key) DO UPDATE SET child_run_id = excluded.child_run_id, status = 'running', outputs = NULL, record = NULL, updated_at = excluded.updated_at`)
      .run(spec.key, spec.stage, spec.sample, childRunId, now, now);
  }

  settled(key: string, status: "completed" | "failed", record: StageRecord | undefined): void {
    this.db.prepare("UPDATE explainer_stage_runs SET status = ?, outputs = ?, record = ?, updated_at = ? WHERE key = ?")
      .run(status, record ? JSON.stringify(record.outputs) : null, record ? JSON.stringify(record) : null, new Date().toISOString(), key);
  }
}

/** A child stage run failed; its record (timing and spend) travels with the error so the parent's report keeps it. */
export class ChildStageFailure extends Error {
  constructor(message: string, readonly record: StageRecord | undefined) {
    super(message);
    this.name = "ChildStageFailure";
  }
}

export const childWorkflow = (stage: string): string => `explainer.${stage}`;
export const BODY_STEP = "body";
/** The step after the body that runs the stage's deterministic checks; its record is the stage's final one. */
export const CHECKS_STEP = "checks";
const ChildRecordSchema = z.object({ result: StageRecordSchema });

/** The record a finished child stage run stored: its checks step's. */
export function childRecord(run: WorkflowRun): StageRecord | undefined {
  const result = Object.values(run.stepResults).find((r) => r.stepId.startsWith(`${CHECKS_STEP}:`) && r.output !== undefined);
  return result ? ChildRecordSchema.parse(JSON.parse(result.output!)).result : undefined;
}

export interface CacheDeps {
  db: Db;
  dataDir: string;
  /** Set once the runtime exists: the routes that call into the cache are built before it. */
  runtime: () => WorkflowRuntime;
  now: () => Date;
}

function hit(row: StageRunRow, at: Date): StageRecord {
  const stored = StageRecordSchema.parse(JSON.parse(row.record ?? "null"));
  const now = at.toISOString();
  return { ...stored, cached: true, key: row.key, childRunId: row.child_run_id, startedAt: now, endedAt: now, wallMs: 0, usage: NO_USAGE, retries: 0 };
}

/**
 * The child a `running` row names, when it can still finish: live here, or claimable after a crash. A failed or
 * cancelled child yields undefined, so the caller starts a fresh one.
 */
async function adoptable(deps: CacheDeps, row: StageRunRow): Promise<string | undefined> {
  const runtime = deps.runtime();
  const child = runtime.status(row.child_run_id);
  if (!child || child.status === "failed" || child.status === "cancelled") return undefined;
  if (child.status !== "running" || (await runtime.wait(row.child_run_id)).status !== "running") return row.child_run_id;
  const others = new Set(runtime.list().map((run) => run.id).filter((id) => id !== row.child_run_id));
  const claimed = await runtime.hydrate({ exclude: others });
  if (!claimed.includes(row.child_run_id)) throw new Error(`stage ${row.stage} child run ${row.child_run_id} is still leased by another process; retry once its lease lapses`);
  return row.child_run_id;
}

function settle(deps: CacheDeps, spec: StageSpec, child: WorkflowRun): StageRecord {
  const store = new StageRunStore(deps.db);
  const record = child.status === "completed" ? childRecord(child) : readJson(runPaths(deps.dataDir, child.id).failed(spec.stage), StageRecordSchema);
  if (child.status !== "completed" || !record) {
    store.settled(spec.key, "failed", record);
    throw new ChildStageFailure(child.error ?? `stage ${spec.stage} child run ${child.id} ended ${child.status}`, record && { ...record, key: spec.key, childRunId: child.id });
  }
  store.settled(spec.key, "completed", record);
  return { ...record, key: spec.key, childRunId: child.id };
}

/**
 * The stage cache: a finished key returns its stored outputs at no cost; a key whose child is still live (or was
 * orphaned by a crash) is adopted; otherwise a new child run starts, its row committed with the run row.
 */
export async function runStageCached(deps: CacheDeps, spec: StageSpec): Promise<StageRecord> {
  const store = new StageRunStore(deps.db);
  const row = store.get(spec.key);
  if (row?.status === "completed") return hit(row, deps.now());
  const adopted = row?.status === "running" ? await adoptable(deps, row) : undefined;
  const runtime = deps.runtime();
  const childId = adopted ?? runtime.start(childWorkflow(spec.stage), { spec: JSON.stringify(spec) }, { onStart: (id) => store.started(spec, id) });
  return settle(deps, spec, await runtime.wait(childId));
}
