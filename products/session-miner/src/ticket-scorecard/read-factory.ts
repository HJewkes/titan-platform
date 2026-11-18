import type { ScorecardGate } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import type { RunSteps } from "./run-facts.js";

const SHEPHERD_WORKFLOW = "shepherd-pr";
const TERMINAL = "('completed', 'failed', 'cancelled')";

export interface Registration {
  taskRef: string;
  /** `owner/name`, as registered. */
  repo: string;
  pr: number | null;
  runId: string;
}

const RegistrationRecord = z.object({ task: z.string(), repo: z.string(), pr: z.number().nullable(), run_id: z.string() });

export function readRegistrations(db: Db): Registration[] {
  return db
    .prepare("SELECT task, repo, pr, run_id FROM shepherd_registration ORDER BY run_id")
    .all()
    .map((r) => {
      const record = RegistrationRecord.parse(r);
      return { taskRef: record.task, repo: record.repo, pr: record.pr, runId: record.run_id };
    });
}

const RunChange = z.object({ id: z.string(), started_at: z.string(), completed_at: z.string().nullable() });

/**
 * Runs that may have changed since `since` (an ISO time): every run still open, and every run that started or ended at or
 * after it. A run's state only moves while it is open, so a closed run older than the mark is final.
 */
export function readRunChanges(db: Db, since: string): { runIds: Set<string>; mark: string } {
  const rows = db
    .prepare(
      `SELECT id, started_at, completed_at FROM workflow_run WHERE workflow_name = ?
         AND (status NOT IN ${TERMINAL} OR started_at >= ? OR completed_at >= ?)`,
    )
    .all(SHEPHERD_WORKFLOW, since, since)
    .map((r) => RunChange.parse(r));
  const times = rows.flatMap((r) => [r.started_at, ...(r.completed_at === null ? [] : [r.completed_at])]);
  return { runIds: new Set(rows.map((r) => r.id)), mark: [since, ...times].sort().at(-1)! };
}

const RunRecord = z.object({ id: z.string(), started_at: z.string(), step_results: z.string() });
const StepRecord = z.object({ stepId: z.string(), completedAt: z.string() });

/** A step id is `<family>` or `<family>:<call index>` (the workflow engine's key); the family names the step. */
function familyOf(stepId: string): string {
  return stepId.split(":")[0]!;
}

/** The completed steps of each run, by family, in completion order. */
export function readRunSteps(db: Db, runIds: readonly string[]): Map<string, RunSteps> {
  const statement = db.prepare("SELECT id, started_at, step_results FROM workflow_run WHERE id = ?");
  const runs = new Map<string, RunSteps>();
  for (const runId of runIds) {
    const raw = statement.get(runId);
    if (raw === undefined) continue;
    const record = RunRecord.parse(raw);
    const results = Object.values(z.record(z.string(), z.unknown()).parse(JSON.parse(record.step_results)));
    const steps = results.flatMap((s) => {
      const step = StepRecord.safeParse(s);
      return step.success ? [{ family: familyOf(step.data.stepId), completedAt: step.data.completedAt }] : [];
    });
    runs.set(runId, { startedAt: record.started_at, steps: steps.sort((a, b) => a.completedAt.localeCompare(b.completedAt)) });
  }
  return runs;
}

/** When each fix-round successor joined the run (`shepherd_lineage` rows with role `successor`). */
export function readSuccessors(db: Db, runIds: readonly string[]): Map<string, string[]> {
  const statement = db.prepare<[string], { at: string }>("SELECT at FROM shepherd_lineage WHERE run_id = ? AND role = 'successor' ORDER BY at");
  return new Map(runIds.map((runId) => [runId, statement.all(runId).map((r) => r.at)]));
}

const GateRecord = z.object({ id: z.string(), created_at: z.string(), resolved_at: z.string().nullable(), resolved_by: z.string().nullable() });
const Resolver = z.object({ class: z.string() }).partial();

function resolverClass(resolvedBy: string | null): string | null {
  if (resolvedBy === null) return null;
  try {
    return Resolver.parse(JSON.parse(resolvedBy)).class ?? null;
  } catch {
    return null;
  }
}

/** A gate's id is `<runId>/<kind>[:n]`, so each run's gates are one primary-key range. */
export function readGates(db: Db, runIds: readonly string[]): Map<string, ScorecardGate[]> {
  const statement = db.prepare("SELECT id, created_at, resolved_at, resolved_by FROM hitl_gate WHERE id >= ? AND id < ? ORDER BY id");
  return new Map(
    runIds.map((runId) => {
      const gates = statement.all(`${runId}/`, `${runId}0`).map((r) => GateRecord.parse(r));
      return [runId, gates.map((g) => ({ createdAt: g.created_at, resolvedAt: g.resolved_at, resolvedByClass: resolverClass(g.resolved_by) }))];
    }),
  );
}

/** Runs with a gate opened or resolved at or after `since`. */
export function readGateChanges(db: Db, since: string): { runIds: Set<string>; mark: string } {
  const rows = db
    .prepare<[string, string], { id: string; created_at: string; resolved_at: string | null }>(
      "SELECT id, created_at, resolved_at FROM hitl_gate WHERE created_at >= ? OR resolved_at >= ?",
    )
    .all(since, since);
  const runIds = new Set(rows.map((r) => r.id.slice(0, Math.max(0, r.id.indexOf("/")))).filter(Boolean));
  const times = rows.flatMap((r) => [r.created_at, ...(r.resolved_at === null ? [] : [r.resolved_at])]);
  return { runIds, mark: [since, ...times].sort().at(-1)! };
}
