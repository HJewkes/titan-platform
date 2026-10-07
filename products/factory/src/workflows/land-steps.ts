import { z } from "zod";

/*
 * One schema per land code step. Each names only the fields its branch reads and lets the rest of the
 * record pass: a step with side effects that then fails its schema fails the run after the effect happened.
 */

const FailingCheck = z.looseObject({
  name: z.string(),
  conclusion: z.string().nullable(),
  url: z.string(),
  workflowRunId: z.number().nullable(),
});

export const LandRulesResult = z.looseObject({ contexts: z.array(z.string()), strict: z.boolean() });

export const CiSnapshotResult = z.looseObject({
  verdict: z.enum(["pending", "green", "red", "behind", "merged", "closed", "not-mergeable"]),
  headSha: z.string(),
  mergeableState: z.string(),
  mergeSha: z.string().nullish(),
  failing: z.array(FailingCheck).optional(),
  backlog: z.boolean().optional(),
  checksGreen: z.boolean().optional(),
  baseMoved: z.boolean().optional(),
  readAt: z.number().optional(),
});

export const UpdateResultResult = z.looseObject({ headSha: z.string(), own: z.boolean(), conflict: z.boolean().optional(), unmoved: z.boolean().optional(), at: z.number().optional() });

export const MergeResultResult = z.looseObject({ done: z.boolean(), skipped: z.string().optional(), mergeSha: z.string() });

/** GitHub's HTTP 405 for a merge that raced another PR into the base; the wire may carry the status only in the message. */
export function baseMovedOrThrow(error: unknown): { done: false; skipped: "base-moved"; mergeSha: string } {
  const { status, message } = error as { status?: number; message?: string };
  const is405 = status === 405 || /\(HTTP 405\)|HTTP 405:/.test(message ?? "");
  if (is405 && /base branch was modified/i.test(message ?? "")) return { done: false, skipped: "base-moved", mergeSha: "" };
  throw error;
}

const PolicyRule = z.looseObject({ table: z.string(), rowId: z.string(), version: z.number() });

export const MergePolicyResult = z.looseObject({ outcome: z.enum(["gate", "allow", "deny"]), headSha: z.string(), rule: PolicyRule, reason: z.string() });

/** Only GitHub's own 422 for an unmergeable base becomes a result; every other failure keeps failing the step. */
export function conflictOrThrow(error: unknown): "conflict" {
  const { status, message } = error as { status?: number; message?: string };
  if (status === 422 && /merge conflict between base and head/i.test(message ?? "")) return "conflict";
  throw error;
}
