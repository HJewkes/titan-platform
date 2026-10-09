import { OwnerBriefSchema } from "@titan-design/review-panel";
import type { SourceTextLocator } from "@titan-design/session-read";
import { z } from "zod";

/** Why a review was dispatched at a head; a run recorded before causes existed reads as `unknown`. */
const REVIEW_CAUSES = ["first", "fix-round", "conflict", "ci-fix", "update-branch", "merge-up-not-carried", "kind-no-carry", "seat-push", "superseded", "retry", "hold", "owner-request", "unknown"] as const;
export type ReviewCauseKind = (typeof REVIEW_CAUSES)[number];

/** `reason` is a carry refusal, a retry reason, or the registered kind that does not carry. */
export const ReviewCauseSchema = z.object({ cause: z.enum(REVIEW_CAUSES), reason: z.string().min(1).optional() });
export type ReviewCause = z.infer<typeof ReviewCauseSchema>;

const Identity = z.object({ agentId: z.string().min(1), sessionId: z.string().min(1) });

/**
 * A verdict locator is the reader's own output and is only handed back to it, so it is checked to be an object and no more:
 * the reader owns its shape, and a stricter copy here would drift from it.
 */
const LocatorSchema = z.custom<SourceTextLocator>((value) => typeof value === "object" && value !== null && !Array.isArray(value), "a locator object");

const CheckRunFact = z.looseObject({ name: z.string(), appId: z.number(), headSha: z.string(), conclusion: z.string().nullable() });
const CarryFact = z.looseObject({ fromHead: z.string(), head: z.string(), headTree: z.string(), mergeTree: z.string() });

const MergeFactsSchema = z.looseObject({
  head: z.string(),
  resolver: Identity,
  dispatchedReviewer: Identity,
  verdict: z.looseObject({ value: z.string(), head: z.string() }),
  requiredContexts: z.array(z.string()),
  allowedApps: z.array(z.number()),
  contextApps: z.record(z.string(), z.array(z.number())).optional(),
  checkRuns: z.array(CheckRunFact),
  mergeTreeClean: z.boolean(),
  repoFrozen: z.boolean(),
  changedPaths: z.array(z.string()),
  seatGrants: z.array(z.string()),
  carry: CarryFact.optional(),
  kind: z.string().optional(),
});

const GateDecisionSchema = z.looseObject({
  outcome: z.enum(["gate", "allow", "deny"]),
  rule: z.looseObject({ table: z.string(), rowId: z.string(), version: z.number() }),
  reason: z.string(),
});

const EvidenceRecordSchema = z.looseObject({
  runId: z.string(),
  repo: z.string(),
  pr: z.number(),
  head: z.string(),
  baseRef: z.string(),
  testMergeSha: z.string().nullable(),
  checkRuns: z.array(z.looseObject({ name: z.string(), id: z.number(), appId: z.number().nullable(), conclusion: z.string().nullable() })),
  verdictLocator: LocatorSchema,
  reviewer: Identity,
  decision: GateDecisionSchema,
  carry: CarryFact.optional(),
});

/** The evidence step's output: the facts observed at one head and the record of what they decided. */
export const MergeEvidenceSchema = z.looseObject({
  head: z.string(),
  merge: MergeFactsSchema,
  record: EvidenceRecordSchema,
  requiredChecksUnknown: z.string().optional(),
  unreadFacts: z.array(z.string()).optional(),
  changedFilesUnread: z.string().optional(),
});

const Intended = z.discriminatedUnion("kind", [z.looseObject({ kind: z.literal("intent"), mode: z.string(), reviewer: z.string() }), z.looseObject({ kind: z.literal("none") })]);
const Dispatched = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("dispatched"), at: z.number(), startedAt: z.number().optional(), profile: z.string().optional(), ...Identity.shape }),
  z.looseObject({ kind: z.literal("none") }),
]);
/** A verdict carries its owner brief, or null when the reviewer wrote none; a brief never changes the verdict. */
const Awaited = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("verdict"), verdict: z.enum(["MERGE", "FIX_FIRST"]), head: z.string(), locator: LocatorSchema, reviewer: Identity, text: z.string().optional(), ownerBrief: OwnerBriefSchema.nullable().optional() }),
  z.looseObject({ kind: z.literal("none") }),
]);
export { Awaited, Dispatched, Intended };
