import { z } from "zod";

/** A member's reply: words a model wrote, or the client's usage-limit notice written in its place. */
const replySchema = z.union([z.strictObject({ say: z.string() }), z.strictObject({ usageLimit: z.strictObject({ resetsAt: z.number() }) })]);

/** What one panel member writes, by attempt; an absent reply is silence, which the workflow reads as a timeout. */
const memberScriptSchema = z.strictObject({
  first: replySchema.optional(),
  /** The reply to a correction turn on the first attempt. */
  corrected: replySchema.optional(),
  /** The reply of the fresh member a retry spawns. */
  retry: replySchema.optional(),
  /** The first attempt's session never starts. */
  neverStarts: z.boolean().optional(),
});

const proofReadSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("result"), line: z.string() }),
  z.strictObject({ kind: z.literal("workflow-ci"), proved: z.boolean(), head: z.string() }),
  z.strictObject({ kind: z.literal("skipped") }),
]);

const sha = z.string().regex(/^[0-9a-f]{40}$/);

/** One recorded head as the fake ports serve it: public PR facts or synthetic text, never a transcript. */
export const replayInputSchema = z.strictObject({
  target: z.strictObject({ repo: z.string(), pr: z.number().int().positive(), head: sha }),
  base: sha,
  kind: z.string(),
  changedFiles: z.array(z.strictObject({ path: z.string(), additions: z.number().int(), deletions: z.number().int() })),
  authorityTouch: z.boolean(),
  /** File text at the head, for the aggregate's and the scorer's citation checks. */
  sources: z.record(z.string(), z.string()),
  proof: proofReadSchema,
  /** Profiles the machine does not have; every other profile is installed. */
  uninstalled: z.array(z.string()),
  members: z.record(z.string(), memberScriptSchema),
});

/** Every case is scored on its outcome kind; a `verdict` case also on whether a verified citation names `path`. */
export const replayExpectedSchema = z.strictObject({
  outcome: z.string(),
  verdict: z.enum(["block", "pass"]).optional(),
  path: z.string().optional(),
  fingerprint: z.string().optional(),
  /** Reviewer sessions spawned, the cost-week waste metric. */
  sessions: z.number().int().nonnegative().optional(),
});

export type Reply = z.infer<typeof replySchema>;
export type MemberScript = z.infer<typeof memberScriptSchema>;
export type ReplayInput = z.infer<typeof replayInputSchema>;
export type ReplayExpected = z.infer<typeof replayExpectedSchema>;
