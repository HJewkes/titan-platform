import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import { resolveCommand } from "../resolve-command.js";
import { NO_APP } from "./review-approval.js";
import type { DigestItem } from "./seat-digest-text.js";
import type { WatchRow } from "./view-schema.js";

export interface DigestInput {
  row: WatchRow;
  run: WorkflowRun;
}

const SEAT_FIX_GATES: ReadonlySet<string> = new Set(["ci-failed", "sh-sent-back", "dead-end"]);
const SeatNoticeRecord = z.looseObject({ result: z.looseObject({ sent: z.literal(true), gate: z.string(), headSha: z.string() }) });
const PublishRecord = z.looseObject({ result: z.looseObject({ headSha: z.string(), review: z.looseObject({ reviewError: z.string() }) }) });

export const prRef = (row: WatchRow): string => `${row.repo}#${row.pr ?? row.branch}`;

export function gateItem(row: WatchRow): DigestItem | undefined {
  const gate = row.pendingGate;
  if (gate === null) return undefined;
  const command = resolveCommand(row.runId, gate.stepId);
  return { key: `gate:${gate.gateId}`, line: `- ${prRef(row)} waits on ${gate.stepId}: \`${command}\``, pr: prRef(row), gate: { stepId: gate.stepId, command } };
}

function latestResult(run: WorkflowRun, stepId: string): StepResult | undefined {
  const results = Object.values(run.stepResults).filter((result) => stepIdMatches(stepId, result.stepId));
  return results.sort((a, b) => a.completedAt.localeCompare(b.completedAt)).at(-1);
}

/** A run the seat was told to fix waits for a new head with no gate and no fixer; only its record shows the seat owns it. */
export function seatFixItem({ row, run }: DigestInput): DigestItem | undefined {
  if (row.pendingGate !== null || row.outcome !== null || run.currentStep === null || !stepIdMatches("await-new-head", run.currentStep)) return undefined;
  const notice = SeatNoticeRecord.safeParse(latestResult(run, "sh-seat-notice")?.data);
  if (!notice.success || !SEAT_FIX_GATES.has(notice.data.result.gate) || notice.data.result.headSha !== row.headSha) return undefined;
  const { gate, headSha } = notice.data.result;
  return { key: `seat:${row.runId}:${gate}:${headSha}`, line: `- ${prRef(row)} ${gate} at ${headSha.slice(0, 7)}, no fixer woken: start a fix round, push a fix, or close the PR`, pr: prRef(row) };
}

/**
 * The newest publish at the PR's head left Shepherd's approvals out of line with its check after the retries (TP-4985),
 * so an approval may still stand or be missing. A missing App is configuration, not news, so it is not told.
 */
export function reviewErrorItem({ row, run }: DigestInput): DigestItem | undefined {
  if (row.outcome !== null) return undefined;
  const record = PublishRecord.safeParse(latestResult(run, "sh-publish-review")?.data);
  if (!record.success || record.data.result.headSha !== row.headSha || record.data.result.review.reviewError === NO_APP) return undefined;
  const { headSha, review } = record.data.result;
  return { key: `review:${row.runId}:${headSha}`, line: `- ${prRef(row)} Shepherd's approval at ${headSha.slice(0, 7)} is out of line with its check: ${review.reviewError}`, pr: prRef(row) };
}

export function finishedItem(row: WatchRow): DigestItem | undefined {
  if (row.outcome === null) return undefined;
  const how = row.outcome.kind === "merged" ? "merged" : `stopped${row.outcome.reason === null ? "" : ` (${row.outcome.reason})`}`;
  return { key: row.runId, line: `- ${prRef(row)} ${how}`, pr: prRef(row) };
}

/**
 * A failed run (TP-4926) leaves its PR with no run driving it, so the seat must re-register it; the step it failed at is the
 * one the run was in when the workflow finished it. Keyed apart from the run id, which the run's settling also records.
 */
export function failedItem({ row, run }: DigestInput): DigestItem | undefined {
  if (run.status !== "failed") return undefined;
  const at = run.currentStep ?? "an unrecorded step";
  const lines = [`- ${prRef(row)} failed at ${at}: ${run.error ?? "no error recorded"}`, `  re-register: titan-factory shepherd register ${prRef(row)}`];
  return { key: `failed:${row.runId}`, line: lines.join("\n"), pr: prRef(row) };
}
