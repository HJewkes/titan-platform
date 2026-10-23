import { usableScope, type EarlierFinding, type ReviewScope } from "@titan-design/review-panel";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { earlierFindingOf, type FixRound } from "./fix-first-trail.js";
import { reviewScopeStep, type ReviewScopeResult } from "./review-scope.js";

/** `shepherd.review.scopedRereview` (TP-3735): `shadow` probes a fix round's diff and records it, `on` also scopes the correctness brief. */
export type ScopedRereviewMode = "off" | "shadow" | "on";

const ScopeSchema = z.object({
  sinceHead: z.string(),
  paths: z.array(z.string()),
  hunks: z.array(z.object({ path: z.string(), start: z.number().int(), end: z.number().int() })),
  mergedBase: z.boolean(),
});
type Scoped = Extract<ReviewScopeResult, { scoped: true }>;

/** The probe writes `git diff -U0`'s line count, where 0 is a pure deletion after `start`; the brief reads that as `end` one below `start`. */
export function toReviewScope({ sinceHead, paths, hunks, mergedBase }: Scoped): z.infer<typeof ScopeSchema> {
  return { sinceHead, paths, mergedBase, hunks: hunks.map(({ path, start, count }) => ({ path, start, end: start + count - 1 })) };
}

const Mode = z.enum(["shadow", "on"]);
const EarlierFindingSchema = z.object({ head: z.string(), text: z.string(), defectClass: z.string().optional() });

/** What the sh-review step is given about a fix round; a refusal keeps its reason, and the brief stays the whole PR's. */
const ScopedRereviewSchema = z.discriminatedUnion("scoped", [
  z.object({ mode: Mode, scoped: z.literal(true), scope: ScopeSchema, earlierFindings: z.array(EarlierFindingSchema).min(1) }),
  z.object({ mode: Mode, scoped: z.literal(false), reason: z.string() }),
]);
type ScopedRereview = z.infer<typeof ScopedRereviewSchema>;
export const SCOPED_REREVIEW_INPUT = { scopedRereview: ScopedRereviewSchema.optional() };

export interface ScopedRereviewWiring {
  /** `shepherd.review.scopedRereview`; absent means `off`, and no fix round is probed. */
  scopedRereview?: ScopedRereviewMode;
}

/** The intent records a mode other than off, so a replay scopes the head as its first run did whatever the config says now. */
export const scopeModeOf = (mode: ScopedRereviewMode | undefined): { scopedRereview?: "shadow" | "on" } => (mode === "shadow" || mode === "on" ? { scopedRereview: mode } : {});

const IntentModeRead = z.looseObject({ scopedRereview: Mode.optional() });

function probe(ctx: WorkflowContext, repo: string, head: string, round: FixRound): Promise<ReviewScopeResult> {
  if (round.baseRef === undefined) return Promise.resolve({ scoped: false, reason: "no base branch was read at this head" });
  return reviewScopeStep(ctx, { repo, baseRef: round.baseRef, sinceHead: round.sinceHead, head });
}

/** Any doubt about the fix diff reviews the whole PR, with the reason recorded; nothing here ever skips a review. */
export async function scopedRereviewOf(ctx: WorkflowContext, request: { repo: string; headSha: string; fixRound?: FixRound }, intent: object): Promise<{ scopedRereview?: ScopedRereview }> {
  const mode = IntentModeRead.safeParse(intent).data?.scopedRereview;
  const round = request.fixRound;
  if (mode === undefined || round === undefined) return {};
  const probed = await probe(ctx, request.repo, request.headSha, round);
  if (!probed.scoped) return { scopedRereview: { mode, scoped: false, reason: probed.reason } };
  const scope = toReviewScope(probed);
  const earlierFindings = round.openFindings.map(earlierFindingOf);
  if (!usableScope(scope, earlierFindings.length)) return { scopedRereview: { mode, scoped: false, reason: "the fix diff failed the brief's scope checks" } };
  return { scopedRereview: { mode, scoped: true, scope, earlierFindings } };
}

/** Only `on` changes the brief; under shadow the brief is an unscoped round's, byte for byte. */
export const scopedBriefFields = (rereview: ScopedRereview | undefined): { scope?: ReviewScope; earlierFindings?: EarlierFinding[] } =>
  rereview?.mode === "on" && rereview.scoped ? { scope: rereview.scope, earlierFindings: rereview.earlierFindings } : {};

/** What review stats read off the sh-review result: whether the round was scoped, why not, and whether that was only the shadow's record. */
export function scopedResultFields(rereview: ScopedRereview | undefined): { scoped?: boolean; scopeReason?: string; scopeShadow?: true } {
  if (rereview === undefined) return {};
  return { scoped: rereview.scoped, ...(!rereview.scoped && { scopeReason: rereview.reason }), ...(rereview.mode === "shadow" && { scopeShadow: true as const }) };
}
