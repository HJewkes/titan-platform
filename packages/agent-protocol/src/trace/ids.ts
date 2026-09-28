import { conversationItemRef, conversationRef } from "../index.js";
import type { ConversationIdentity, UsageMeasurement } from "../index.js";

const COMPONENT = "[^:\\s]+";
const REPO = "[^/\\s#@:]+/[^/\\s#@:]+";
const SHA40 = "[0-9a-f]{40}";

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const REPO_PATTERN = new RegExp(`^${REPO}$`);
export const COMMIT_SHA_PATTERN = new RegExp(`^${SHA40}$`);

/** The shape `workflowStepRequestKey` emits: four URI-encoded components, the last two integers. */
export const ATTEMPT_ID_PATTERN = new RegExp(`^workflow:${COMPONENT}:${COMPONENT}:\\d+:\\d+$`);
/** `gateIdFor` and `assistedKey`: `<runId>/<stepId>` with an optional `:<iteration>`. */
export const HUMAN_GATE_ID_PATTERN = /^[^/\s]+\/\S+$/;
export const POLICY_GATE_ID_PATTERN = new RegExp(`^workflow:${COMPONENT}:${COMPONENT}:\\d+:\\d+#policy:${COMPONENT}:${COMPONENT}$`);
export const COMMIT_ID_PATTERN = new RegExp(`^commit:${REPO}@${SHA40}$`);
export const PR_ID_PATTERN = new RegExp(`^pr:${REPO}#[1-9]\\d*$`);
/** `fileRef` plus an `@<sha>` suffix, so two versions of one file get different ids. */
export const FILE_ID_PATTERN = new RegExp(`^file:${REPO}/\\S.*@${SHA40}$`);
export const CALL_ID_PATTERN = new RegExp(`^(?:call|response):${COMPONENT}:${COMPONENT}:${COMPONENT}:${COMPONENT}$`);
export const COST_ID_PATTERN = /^cost:(?:response|conversation):\S+$/;
export const CONVERSATION_REF_PATTERN = new RegExp(`^conversation:${COMPONENT}:${COMPONENT}:${COMPONENT}$`);
export const TURN_REF_PATTERN = new RegExp(`^turn:${COMPONENT}:${COMPONENT}:${COMPONENT}:${COMPONENT}$`);

export function commitRef(repo: string, sha: string): string {
  if (!REPO_PATTERN.test(repo)) throw new TypeError(`repo must be owner/name, got ${JSON.stringify(repo)}`);
  if (!COMMIT_SHA_PATTERN.test(sha)) throw new TypeError(`commit sha must be 40 lowercase hex characters, got ${JSON.stringify(sha)}`);
  return `commit:${repo}@${sha}`;
}

export function policyGateId(attemptId: string, table: string, rowId: string): string {
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new TypeError(`attemptId must be a workflow step request key, got ${JSON.stringify(attemptId)}`);
  return `${attemptId}#policy:${component(table)}:${component(rowId)}`;
}

/** Deltas key on the response id; snapshots on their scope and epoch, so the latest sequence upserts over earlier ones. */
export function costId(conversation: ConversationIdentity, measurement: UsageMeasurement): string {
  if (measurement.kind === "delta") return `cost:${conversationItemRef(conversation, "response", measurement.responseId)}`;
  const scope = [measurement.scope, measurement.scopeId, measurement.epoch].map(component).join(":");
  return `cost:${conversationRef(conversation)}:${scope}`;
}

function component(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("id components must be nonempty strings");
  return encodeURIComponent(value);
}
