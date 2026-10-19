import { z } from "zod";
import { HoldSatisfiedBySchema } from "./hold-satisfaction.js";
import { ownerHoldOf } from "./owner-hold-rows.js";
import { EffectivePolicySchema } from "./policy.js";
import { registrationFactsOf } from "./registration-facts.js";
import type { RegistrationRow } from "./registration-row.js";
import type { Registration } from "./store.js";
import { TASK_KINDS } from "./task-kind.js";

const KindSchema = z.enum(TASK_KINDS);

/** The registration a `shepherd_registration` row holds; an owner-asked hold reads as held whatever the legacy flag says. */
export function registrationOf(row: RegistrationRow): Registration {
  const ownerHold = ownerHoldOf(row);
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
    held: row.held === 1 || ownerHold !== null,
    holdReason: row.hold_reason ?? ownerHold?.reason ?? null,
    holdReviewer: row.hold_reviewer ?? null,
    holdSatisfied: row.hold_satisfied_head && row.hold_satisfied_by ? { head: row.hold_satisfied_head, by: HoldSatisfiedBySchema.parse(JSON.parse(row.hold_satisfied_by)) } : null,
    releaseReady: row.release_ready_head && row.release_ready_at ? { head: row.release_ready_head, at: row.release_ready_at } : null,
    reviewRequest: row.review_request_head && row.review_request_at ? { head: row.review_request_head, at: row.review_request_at, takenAt: row.review_request_taken_at ?? null } : null,
    ownerHold,
    ...registrationFactsOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
