import type { RepoSlug } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import { registeredKind } from "./merge-facts.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { mergeVerdict } from "./review.js";
import { carryStep, type CarryResult } from "./tree-carry.js";

export const CARRY_SCOPE_STEP = "sh-carry-scope";
export const CARRY_SCOPE_STEPS: readonly StepDeclaration[] = [{ id: CARRY_SCOPE_STEP, kind: "dispatch" }];

/** Kinds whose reviewed MERGE a tree-equal update may reuse; a security change always gets a fresh reviewer. */
export const CARRYING_KINDS: ReadonlySet<string> = new Set(["correctness", "feature", "refactor"]);

interface CarryTarget {
  repo: RepoSlug;
  pr: number;
}

const ScopeResult = z.looseObject({ kind: z.string().nullable(), baseRef: z.string().nullable() });

/** The registration's kind and the PR's base branch, both read by code; the reviewer's text and the PR's labels, title and body never reach this step. */
export function carryScopeRoute(deps: Pick<ShepherdDeps, "port" | "store" | "now">): StepRoute {
  return codeRoute(CARRY_SCOPE_STEP, deps.now, async (input: CarryTarget & { runId: string }) => ({
    kind: registeredKind(deps.store, input.runId) ?? null,
    baseRef: (await deps.port.getPr(input.repo, input.pr)).baseRef,
  }));
}

const Evidence = z.looseObject({
  head: z.string().regex(HEAD),
  merge: z.looseObject({
    head: z.string().regex(HEAD),
    verdict: z.looseObject({ value: z.literal("MERGE"), head: z.string().regex(HEAD) }),
    resolver: z.looseObject({ agentId: z.string().min(1), sessionId: z.string().min(1) }),
    dispatchedReviewer: z.looseObject({ agentId: z.string().min(1), sessionId: z.string().min(1) }),
    seatGrants: z.array(z.string()),
  }),
  record: z.looseObject({ verdictLocator: z.looseObject({}) }),
});
type SourceEvidence = z.infer<typeof Evidence>;

/** The newest verdict this run took, other than at `headSha`; an older MERGE behind a FIX_FIRST is never reached. */
function latestVerdict(reviews: ReadonlyMap<string, Verdict>, headSha: string): Verdict | undefined {
  return [...reviews].reverse().find(([head]) => head !== headSha)?.[1];
}

/** The MERGE a tree-equal head may carry: the newest verdict is a MERGE and its recorded evidence is whole and about its own head. */
export function carriedSource(reviews: ReadonlyMap<string, Verdict>, headSha: string): SourceEvidence | undefined {
  const latest = latestVerdict(reviews, headSha);
  if (latest?.kind !== "MERGE") return undefined;
  const evidence = Evidence.safeParse(latest.evidence);
  return evidence.success && evidence.data.merge.head === latest.headSha ? evidence.data : undefined;
}

/** Only an equal answer whose two trees agree is a carry. */
function treeEqual(result: CarryResult): boolean {
  return result.equal && !!result.headTree && result.headTree === result.mergeTree;
}

/**
 * At a new green head, reuse the newest MERGE across a tree-equal update instead of dispatching a reviewer. Undefined means
 * review as usual: no MERGE to carry, a kind that does not carry, or a probe that did not answer equal.
 */
export async function carriedVerdict(ctx: WorkflowContext, target: CarryTarget, reviews: ReadonlyMap<string, Verdict>, headSha: string, scopeRead: number): Promise<Verdict | undefined> {
  const source = carriedSource(reviews, headSha);
  if (!source) return undefined;
  const scope = await step(ctx, `${CARRY_SCOPE_STEP}:${scopeRead}`, { ...target, runId: ctx.runId }, ScopeResult);
  if (scope.kind === null || !CARRYING_KINDS.has(scope.kind) || scope.baseRef === null) return undefined;
  const fromHead = source.merge.verdict.head;
  const result = await carryStep(ctx, { repo: target.repo, baseRef: scope.baseRef, fromHead, head: headSha });
  if (!treeEqual(result)) return undefined;
  const { merge } = source;
  return mergeVerdict(ctx, {
    ...target,
    head: headSha,
    verdict: { value: "MERGE", head: fromHead, locator: source.record.verdictLocator as unknown as SourceTextLocator },
    resolver: merge.resolver,
    dispatchedReviewer: merge.dispatchedReviewer,
    seatGrants: merge.seatGrants,
    carry: { fromHead, head: headSha, result },
  });
}
