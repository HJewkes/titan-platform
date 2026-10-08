import type { ForcePush, RepoSlug } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import { failureOf } from "./error-class.js";
import { seatFixFirst } from "./external-review.js";
import { registeredKind } from "./merge-facts.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { mergeVerdict, type ReviewWiring } from "./review.js";
import { REMERGE_STEP, remergeRoute, remergeStep, type CarryRule, type RemergeResult } from "./remerge-carry.js";
import { carryStep, type CarryInput, type CarryResult } from "./tree-carry.js";

const CARRY_SCOPE_STEP = "sh-carry-scope";
const CARRY_SEAT_STEP = "sh-carry-seat";
/** Records an approve-merge answer that followed a head to its remerge-clean update, so the ledger shows why no gate opened. */
export const APPROVAL_CARRY_STEP = "sh-approval-carry";
export const CARRY_SCOPE_STEPS: readonly StepDeclaration[] = [
  { id: CARRY_SCOPE_STEP, kind: "dispatch" },
  { id: CARRY_SEAT_STEP, kind: "dispatch" },
  { id: REMERGE_STEP, kind: "dispatch" },
  { id: APPROVAL_CARRY_STEP, kind: "dispatch" },
];

/** Kinds whose reviewed MERGE a tree-equal update may reuse; a security change always gets a fresh reviewer. */
export const CARRYING_KINDS: ReadonlySet<string> = new Set(["correctness", "feature", "refactor"]);

export interface CarryTarget {
  repo: RepoSlug;
  pr: number;
}

const ScopeResult = z.looseObject({ kind: z.string().nullable(), baseRef: z.string().nullable() });

/** The base branch a carry probes against, or undefined when the run's kind does not carry or the base is unknown. */
export async function carryingBase(ctx: WorkflowContext, target: CarryTarget, read: string): Promise<string | undefined> {
  const scope = await step(ctx, `${CARRY_SCOPE_STEP}:${read}`, { ...target, runId: ctx.runId }, ScopeResult);
  return scope.kind !== null && CARRYING_KINDS.has(scope.kind) && scope.baseRef !== null ? scope.baseRef : undefined;
}

/** The registration's kind and the PR's base branch, both read by code; the reviewer's text and the PR's labels, title and body never reach this step. */
function carryScopeRoute(deps: Pick<ShepherdDeps, "port" | "store" | "now">): StepRoute {
  return codeRoute(CARRY_SCOPE_STEP, deps.now, async (input: CarryTarget & { runId: string }) => ({
    kind: registeredKind(deps.store, input.runId).kind ?? null,
    baseRef: (await deps.port.getPr(input.repo, input.pr)).baseRef,
  }));
}

const SeatResult = z.looseObject({ clear: z.boolean() });

/** Each head costs a roster read and a transcript scan per seat reviewer, and nothing caches them per head, so a longer walk refuses. */
export const CARRY_SEAT_HEAD_CAP = 50;

interface SeatInput extends CarryTarget {
  fromHead: string;
  head: string;
  heads: string[];
}

type SeatHeads = { heads: string[] } | { reason: string };
type SeatRead<T> = { value: T } | { reason: string };

/** A failed read refuses under a fixed name, never the error's own text. */
async function seatRead<T>(what: string, read: () => Promise<T>): Promise<SeatRead<T>> {
  try {
    return { value: await read() };
  } catch (error) {
    return { reason: `seat check: ${what} could not be read (${failureOf(error)})` };
  }
}

/** The PR's commits after `fromHead`; after a rebase `fromHead` is not in the list, so every commit counts. */
async function committedSince(port: ShepherdDeps["port"], input: SeatInput): Promise<SeatRead<string[]>> {
  const commits = await seatRead("the PR's commit list", () => port.listPrCommits(input.repo, input.pr));
  if ("reason" in commits) return commits;
  if (commits.value.at(-1) !== input.head) return { reason: `seat check: the PR's commit list does not end at ${input.head}` };
  return { value: commits.value.slice(commits.value.indexOf(input.fromHead) + 1) };
}

/**
 * The heads force-pushes removed after the branch held `fromHead`. A push that removed `fromHead` counts, one that brought it
 * does not; with `fromHead` in no push every removed head counts, as after a rebase.
 */
export function pushedAwaySince(pushes: readonly ForcePush[], fromHead: string): (string | null)[] {
  let start = 0;
  pushes.forEach((push, index) => {
    if (push.after === fromHead) start = index + 1;
    else if (push.before === fromHead) start = index;
  });
  return pushes.slice(start).map((push) => push.before);
}

/** The heads force-pushed away since `fromHead`, which the commit list no longer names; one GitHub no longer has refuses. */
async function forcedAwaySince(port: ShepherdDeps["port"], input: SeatInput): Promise<SeatRead<string[]>> {
  const pushes = await seatRead("the PR's force-pushes", () => port.listForcePushes(input.repo, input.pr));
  if ("reason" in pushes) return pushes;
  const away = pushedAwaySince(pushes.value, input.fromHead);
  const known = away.filter((head): head is string => head !== null);
  return known.length === away.length ? { value: known } : { reason: `seat check: a head force-pushed away since ${input.fromHead} is gone from GitHub` };
}

/**
 * The run's heads, every commit the PR passed through after `fromHead`, and every head force-pushed away since, so a seat
 * FIX_FIRST at an update the run never reviewed still refuses. A list that does not end at the head is short (GitHub stops at
 * 250) or stale, and refuses.
 */
async function seatHeads(port: ShepherdDeps["port"], input: SeatInput): Promise<SeatHeads> {
  const committed = await committedSince(port, input);
  if ("reason" in committed) return committed;
  const forced = await forcedAwaySince(port, input);
  if ("reason" in forced) return forced;
  const heads = [...new Set([...input.heads, ...committed.value, ...forced.value])];
  if (heads.length > CARRY_SEAT_HEAD_CAP) return { reason: `seat check: ${heads.length} heads since ${input.fromHead} is more than ${CARRY_SEAT_HEAD_CAP}` };
  return { heads };
}

/**
 * Reads every seat reviewer at each head a carry would vouch for, so a FIX_FIRST at any of them refuses it, as the fresh review
 * at that head would have. An unreadable roster, transcript, commit list or force-push list refuses too. With no dispatch wired there is no
 * roster to read.
 */
export function carrySeatRoute(deps: Pick<ShepherdDeps, "now" | "port">, wiring: ReviewWiring | undefined): StepRoute {
  return codeRoute(CARRY_SEAT_STEP, deps.now, async (input: SeatInput) => {
    const dispatch = wiring?.dispatch;
    if (!dispatch) return { clear: true };
    const walked = await seatHeads(deps.port, input);
    if ("reason" in walked) return { clear: false, reason: walked.reason };
    for (const head of walked.heads) {
      const check = await seatFixFirst(() => dispatch.roster(), wiring.reader, { repo: input.repo, pr: input.pr, head });
      if (check.kind !== "clear") return { clear: false, reason: check.kind === "none" ? check.reason : `a seat reviewer said FIX_FIRST at ${head}` };
    }
    return { clear: true };
  });
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

/** What the evidence step records about a carry: both heads, the tree probe's answer, the rule that carried, and the remerge answer behind a remerge rule. */
interface CarryEvidence {
  fromHead: string;
  head: string;
  result: CarryResult;
  rule: CarryRule;
  remerge?: RemergeResult;
}

/** The tree probe decides first; a head it refuses may still be the reviewed head plus a merge whose remerge-diff resolved nothing reviewed. */
async function carryRule(ctx: WorkflowContext, input: CarryInput): Promise<CarryEvidence | undefined> {
  const at = { fromHead: input.fromHead, head: input.head };
  const result = await carryStep(ctx, input);
  if (treeEqual(result)) return { ...at, result, rule: "tree-equal" };
  const remerge = await remergeStep(ctx, input);
  return remerge.carries && remerge.rule ? { ...at, result, rule: remerge.rule, remerge } : undefined;
}

/**
 * At a new green head, reuse the newest MERGE across a tree-equal or remerge-clean update instead of dispatching a reviewer.
 * Undefined means review as usual: no MERGE to carry, a kind that does not carry, or neither probe carried.
 */
export async function carriedVerdict(ctx: WorkflowContext, target: CarryTarget, reviews: ReadonlyMap<string, Verdict>, headSha: string, scopeRead: number): Promise<Verdict | undefined> {
  const source = carriedSource(reviews, headSha);
  if (!source) return undefined;
  const baseRef = await carryingBase(ctx, target, String(scopeRead));
  if (baseRef === undefined) return undefined;
  const fromHead = source.merge.verdict.head;
  const carry = await carryRule(ctx, { repo: target.repo, baseRef, fromHead, head: headSha });
  if (!carry) return undefined;
  const heads = [...new Set([fromHead, ...reviews.keys(), headSha])];
  const seats = await step(ctx, `${CARRY_SEAT_STEP}:${headSha}`, { ...target, fromHead, head: headSha, heads }, SeatResult);
  if (!seats.clear) return undefined;
  const { merge } = source;
  return mergeVerdict(ctx, {
    ...target,
    head: headSha,
    verdict: { value: "MERGE", head: fromHead, locator: source.record.verdictLocator as unknown as SourceTextLocator },
    resolver: merge.resolver,
    dispatchedReviewer: merge.dispatchedReviewer,
    seatGrants: merge.seatGrants,
    carry,
  });
}

/** The routes the carry steps dispatch to; the remerge probe reaches git as the tree probe does. */
export function carryRoutes(deps: Pick<ShepherdDeps, "port" | "store" | "now">, wiring: ReviewWiring | undefined): StepRoute[] {
  return [
    carryScopeRoute(deps),
    carrySeatRoute(deps, wiring),
    remergeRoute(deps.now, wiring?.carry),
    codeRoute(APPROVAL_CARRY_STEP, deps.now, async (input: object) => input),
  ];
}
