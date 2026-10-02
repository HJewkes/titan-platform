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
});

export const UpdateResultResult = z.looseObject({ headSha: z.string(), own: z.boolean(), conflict: z.boolean().optional() });

export const MergeResultResult = z.looseObject({ done: z.boolean(), skipped: z.string().optional(), mergeSha: z.string() });

const PolicyRule = z.looseObject({ table: z.string(), rowId: z.string(), version: z.number() });

export const MergePolicyResult = z.looseObject({ outcome: z.enum(["gate", "allow", "deny"]), headSha: z.string(), rule: PolicyRule, reason: z.string() });

/** Only GitHub's own 422 for an unmergeable base becomes a result; every other failure keeps failing the step. */
export function conflictOrThrow(error: unknown): "conflict" {
  const { status, message } = error as { status?: number; message?: string };
  if (status === 422 && /merge conflict between base and head/i.test(message ?? "")) return "conflict";
  throw error;
}
