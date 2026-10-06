import type { SourceTextLocator } from "@titan-design/session-read";
import { z } from "zod";

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
});

/** The most of a reviewer's OWNER-BRIEF block that is read; a longer block is malformed rather than cut. */
export const MAX_OWNER_BRIEF_CHARS = 2000;
export const OWNER_BRIEF_START = "OWNER-BRIEF";
export const OWNER_BRIEF_END = "END-OWNER-BRIEF";

const Bullets = z.array(z.string().min(1).max(300)).min(1).max(5);

/** What the owner is asked about a gated PR, as the reviewer who read the diff wrote it. */
const OwnerBriefSchema = z.strictObject({
  what: z.string().min(1).max(500),
  why: z.string().min(1).max(500),
  pros: Bullets,
  cons: Bullets,
  doorType: z.enum(["two-way", "one-way"]),
});

export type OwnerBrief = z.infer<typeof OwnerBriefSchema>;

type Draft = { what?: string; why?: string; door?: string; pros: string[]; cons: string[] };

/** Folds one body line into the draft; false when the line fits no field, so the block is malformed. */
function takeLine(draft: Draft, line: string, list: { current: string[] | null }): boolean {
  if (line === "") return true;
  const single = /^(What|Why|Door): (.+)$/.exec(line);
  if (single) {
    const key = single[1] === "What" ? "what" : single[1] === "Why" ? "why" : "door";
    if (draft[key] !== undefined) return false;
    draft[key] = single[2]!;
    list.current = null;
    return true;
  }
  if (line === "Pros:" || line === "Cons:") return (list.current = line === "Pros:" ? draft.pros : draft.cons), true;
  const bullet = /^- (.+)$/.exec(line);
  if (!bullet || list.current === null) return false;
  list.current.push(bullet[1]!);
  return true;
}

/**
 * The one OWNER-BRIEF block after the verdict line, or null when there is none or it is malformed, too long or has
 * a door type other than two-way or one-way. Only the parsed fields are returned, never the surrounding text.
 */
export function parseOwnerBrief(text: string): OwnerBrief | null {
  const lines = text.split("\n").map((line) => line.trim());
  const verdictAt = lines.findIndex((line) => line.startsWith("Verdict:"));
  const starts = lines.flatMap((line, index) => (index > verdictAt && verdictAt >= 0 && line === OWNER_BRIEF_START ? [index] : []));
  if (starts.length !== 1) return null;
  const end = lines.indexOf(OWNER_BRIEF_END, starts[0]);
  const body = lines.slice(starts[0]! + 1, end < 0 ? undefined : end);
  if (body.join("\n").length > MAX_OWNER_BRIEF_CHARS) return null;
  const draft: Draft = { pros: [], cons: [] };
  const list = { current: null as string[] | null };
  if (!body.every((line) => takeLine(draft, line, list))) return null;
  const parsed = OwnerBriefSchema.safeParse({ what: draft.what, why: draft.why, pros: draft.pros, cons: draft.cons, doorType: draft.door });
  return parsed.success ? parsed.data : null;
}

const Intended = z.discriminatedUnion("kind", [z.looseObject({ kind: z.literal("intent"), mode: z.string(), reviewer: z.string() }), z.looseObject({ kind: z.literal("none") })]);
const Dispatched = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("dispatched"), at: z.number(), startedAt: z.number().optional(), ...Identity.shape }),
  z.looseObject({ kind: z.literal("none") }),
]);
/** A verdict carries its owner brief, or null when the reviewer wrote none; a brief never changes the verdict. */
const Awaited = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("verdict"), verdict: z.enum(["MERGE", "FIX_FIRST"]), head: z.string(), locator: LocatorSchema, reviewer: Identity, text: z.string().optional(), ownerBrief: OwnerBriefSchema.nullable().optional() }),
  z.looseObject({ kind: z.literal("none") }),
]);
export { Awaited, Dispatched, Intended };
