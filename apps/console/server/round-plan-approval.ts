/**
 * The plan round's answer kind (TP-4357, audit C1): the owner's `approve` pick on a question `planApprovals` binds becomes one
 * TP-4284 `plan-approval` action record, posted to the factory's `/owner/console-action` like any inbox tap. The factory
 * writes the row as the console's owner-remote, keyed by the record's sha256, so the waive-proof tap's binding holds:
 * one record, one row, and a repost of the same bytes reads back `already`.
 *
 * Only the owner's own submit writes a record. It is named for its round and question and written once (O_EXCL, 0600, in the
 * 0700 actions dir), from a feedback.json bound to the round.json bytes on disk. The start-up sweep only reposts a record
 * that submit wrote while the factory was unreachable, so a feedback.json some other process put in the rounds dir, a
 * relayed or decided answer included, never becomes an approval.
 */
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import type { OwnerActionClient } from "./owner-action.js";
import { outcomeFile, settleOutcome, writeRecord } from "./owner-tap.js";
import type { Feedback, Manifest } from "./round-schema.js";

export interface PlanApprovalDeps {
  /** The factory's `consoleAnswers.actionsDir`, as the inbox taps use it. */
  actionsDir: string;
  client: OwnerActionClient;
}

interface ApprovedPlan {
  actionId: string;
  record: object;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Fits the factory's 64-character action id; a round id has no slash, so round and question never run together. */
const actionIdOf = (roundId: string, questionId: string): string => `plan-${sha256(`${roundId}/${questionId}`).slice(0, 40)}`;

/** One record per bound question the owner answered with its `approve` option; a revision request carries no pick, so approves nothing. */
export function approvedPlans(roundId: string, manifest: Manifest, feedback: Feedback): ApprovedPlan[] {
  return (manifest.planApprovals ?? []).flatMap(({ questionId, approve, task, repo, gate, scope }) => {
    const answer = feedback.answers.find((each) => each.questionId === questionId);
    if (answer?.pick !== approve) return [];
    const action = { kind: "plan-approval", task, repo, round: roundId, gate, scope };
    const record = { itemId: `round:${roundId}/${questionId}`, action, manifestSha256: feedback.manifestSha256, at: feedback.submittedAt };
    return [{ actionId: actionIdOf(roundId, questionId), record }];
  });
}

const fileOf = (deps: PlanApprovalDeps, plan: ApprovedPlan): string => path.join(deps.actionsDir, `${plan.actionId}.json`);
const present = (file: string): Promise<boolean> => access(file).then(() => true, () => false);

/** The owner's submit only: an existing record is left as it is, so a second write can never mint a second row. */
export async function writePlanApprovals(deps: PlanApprovalDeps, plans: readonly ApprovedPlan[]): Promise<void> {
  for (const plan of plans) await writeRecord(deps.actionsDir, fileOf(deps, plan), plan.record);
}

/** Posts each written record with no settled outcome; an unreachable factory leaves it for the next sweep. */
export async function postPlanApprovals(deps: PlanApprovalDeps, plans: readonly ApprovedPlan[], at: Date): Promise<void> {
  for (const plan of plans) {
    const file = fileOf(deps, plan);
    if (!(await present(file)) || (await present(outcomeFile(file)))) continue;
    await settleOutcome(file, await deps.client.post(plan.actionId), at.toISOString());
  }
}
