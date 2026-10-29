import { buildDigest, EMPTY_REGISTRIES, PlannedSchema, QueueOpsSchema, quotaViolations, type ArPorts } from "@titan-design/autoresearch";
import { z } from "zod";

interface DryRunReport {
  ok: boolean;
  agent?: string;
  usd?: number;
  adds: number;
  /** Every reason the round-1 answer would fail the run: a parse error, a schema miss or a quota miss. */
  violations: string[];
}

/**
 * Round 1's planner turn alone, against an empty digest, checked as the workflow checks it. No pin, baseline or
 * implementer runs, so a brief or contract defect costs one planner turn rather than a run's baselines.
 */
export async function planDryRun(plan: ArPorts["plan"], options: { runId: string; minPool: number }, signal: AbortSignal): Promise<DryRunReport> {
  const quota = { keptLastRound: [], minPool: options.minPool, queuedBefore: 0 };
  const digest = buildDigest({ round: 1, evidence: [], registries: EMPTY_REGISTRIES, queue: [] });
  const planned = PlannedSchema.parse(await plan({ runId: options.runId, round: 1, digest, violations: [], quota, mode: "spawn" }, signal));
  const who = { ...(planned.agent === undefined ? {} : { agent: planned.agent }), ...(planned.usage === undefined ? {} : { usd: planned.usage.usd }) };
  if (planned.malformed !== undefined) return { ok: false, ...who, adds: 0, violations: [planned.malformed] };
  const ops = QueueOpsSchema.safeParse(planned.ops);
  if (!ops.success) return { ok: false, ...who, adds: 0, violations: [`[ops-schema] ${z.prettifyError(ops.error)}`] };
  const violations = quotaViolations(ops.data, quota);
  return { ok: violations.length === 0, ...who, adds: ops.data.add.length, violations };
}
