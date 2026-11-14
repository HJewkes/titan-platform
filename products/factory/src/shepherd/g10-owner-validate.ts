// Gate model S8b (TP-5411): a task tagged owner-validate is worked only under the owner's console task approval. The
// `g10-` prefix keeps this rule in MERGE_POLICY_FILES, so a change to it stops for the owner as g10-low-tier.ts does.
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import type { GateDecision, PolicyRule } from "../gate-policy.js";
import { collapsedDoneWhen, type PlanApproval, type TaskApproval } from "./plan-approval.js";

export const OWNER_VALIDATE_TAG = "owner-validate";

/** `shepherd.gateReset.ownerValidate`: absent means `shadow`, which records the would-gate and changes no outcome. */
export type OwnerValidateMode = "off" | "shadow" | "on";

/** A task as active-work answered it, or why it could not be read: the daemon down, or a key that resolves to no task. */
export type OwnerValidateTask = { tags: readonly string[]; doneWhen: string } | { unread: string };

export type OwnerValidateRefusal = "no-approval" | "done-when-changed" | "task-unread";

/** Undefined when the task may be worked: untagged, or approved by the owner for the done_when it holds now. */
export function ownerValidateRefusal(task: OwnerValidateTask, approval: TaskApproval | undefined): OwnerValidateRefusal | undefined {
  if ("unread" in task) return "task-unread";
  if (!task.tags.includes(OWNER_VALIDATE_TAG)) return undefined;
  if (approval === undefined) return "no-approval";
  return approval.scope.doneWhen === collapsedDoneWhen(task.doneWhen) ? undefined : "done-when-changed";
}

/** What the merge-evidence step read for the run's task; only a tagged or unread task is stamped. */
interface OwnerValidateStamp {
  mode: Exclude<OwnerValidateMode, "off">;
  task: string;
  tagged: true | "unread";
  doneWhen?: string;
  unread?: string;
}

export interface OwnerValidateField {
  /** Read back unvalidated from a stored record, so decide time parses it itself. */
  ownerValidate?: OwnerValidateStamp;
}

/** A route that lost its mode wiring passes `undefined`, which fails closed as `on`. */
export function ownerValidateStamp(mode: OwnerValidateMode | undefined, task: string, read: OwnerValidateTask): OwnerValidateField {
  const live = mode ?? "on";
  if (live === "off") return {};
  if ("unread" in read) return { ownerValidate: { mode: live, task, tagged: "unread", unread: read.unread } };
  return read.tags.includes(OWNER_VALIDATE_TAG) ? { ownerValidate: { mode: live, task, tagged: true, doneWhen: read.doneWhen } } : {};
}

/** A stamp that is not a well-formed tagged read decides as unread, so a damaged record still gates under `on`. */
function stampedTask(stamp: Record<string, unknown>): OwnerValidateTask {
  if (stamp.tagged === true && typeof stamp.doneWhen === "string") return { tags: [OWNER_VALIDATE_TAG], doneWhen: stamp.doneWhen };
  return { unread: typeof stamp.unread === "string" ? stamp.unread : "the stamped task read is malformed" };
}

const REFUSAL_WORDS: Record<OwnerValidateRefusal, string> = {
  "no-approval": `is tagged ${OWNER_VALIDATE_TAG} and holds no owner task approval`,
  "done-when-changed": `is tagged ${OWNER_VALIDATE_TAG} and its owner task approval is for an older done_when`,
  "task-unread": `could not be read from active-work, so it may be tagged ${OWNER_VALIDATE_TAG}`,
};

/**
 * Under `on`, an allow on a head whose run's task is tagged owner-validate or unread gates unless `approved` holds the
 * owner's task approval for its done_when; under `shadow` the allow names the would-gate. A gate is left as it is.
 */
export function ownerValidateDecided(decision: GateDecision, stamp: unknown, approved: readonly PlanApproval[] | undefined, rule: PolicyRule): GateDecision {
  if (decision.outcome !== "allow" || !isObjectLike(stamp)) return decision;
  const approval = approved?.find((each): each is TaskApproval => each.gate === "task");
  const refusal = ownerValidateRefusal(stampedTask(stamp), approval);
  if (refusal === undefined) return decision;
  const words = `task ${String(stamp.task)} ${REFUSAL_WORDS[refusal]} (${refusal})`;
  if (stamp.mode === "shadow") return { ...decision, reason: `${decision.reason}; owner validate would gate: ${words}` };
  return { outcome: "gate", rule, reason: `owner validate: ${words}` };
}
