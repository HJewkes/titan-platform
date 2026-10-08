import type { RepoSlug } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step, type CiSnapshot } from "../workflows/land.js";
import type { ShepherdDeps, Verdict } from "./phases.js";

export const G10_RELEASE_STEP = "sh-g10-release";
export const G10_RELEASE_STEPS: readonly StepDeclaration[] = [{ id: G10_RELEASE_STEP, kind: "dispatch" }];

/**
 * A hold's class is the text before the first colon of its reason, matched exactly: no trimming. Only `g10-review` releases itself; `g10-adversary`
 * (authority, merge-policy and security PRs, until a seat's fail-open reviewer is Shepherd's) and every other class wait for a seat.
 */
const G10_REVIEW_CLASS = "g10-review";

export const holdClassOf = (reason: string | null | undefined): string | undefined => (reason?.includes(":") ? reason.slice(0, reason.indexOf(":")) : undefined);

/** Profiles whose model is Opus: the G10 review is an opus reviewer's, and the profile name is all Shepherd can read of the model. */
const OPUS_PROFILES: ReadonlySet<string> = new Set(["bd-reviewer"]);
export const isOpusProfile = (profile: string | undefined): boolean => profile !== undefined && (OPUS_PROFILES.has(profile) || /(^|[-_])opus([-_]|$)/i.test(profile));

const Identity = z.looseObject({ agentId: z.string(), sessionId: z.string() });

/** The reviewer's answer at one head and where it was written: the verdict ref a release records. */
const G10VerdictSchema = z.looseObject({ value: z.string(), head: z.string(), reviewer: Identity, locator: z.custom<SourceTextLocator>((value) => typeof value === "object" && value !== null) });
export type G10Verdict = z.infer<typeof G10VerdictSchema>;

interface G10Run {
  held: boolean;
  holdReason: string | null;
}

interface G10Checks {
  head: string;
  green: boolean;
}

/**
 * True when the run is held as `g10-review` and an opus reviewer's MERGE stands at the PR's head as read now, with
 * the required checks green at that same head. The head is the caller's fresh read, never the run's recorded one.
 */
export function satisfiesG10(run: G10Run, verdict: G10Verdict | undefined, prHead: string, checks: G10Checks, reviewProfile: string | undefined): boolean {
  if (!run.held || holdClassOf(run.holdReason) !== G10_REVIEW_CLASS) return false;
  if (!isOpusProfile(reviewProfile)) return false;
  return verdict?.value === "MERGE" && verdict.head === prHead && checks.green && checks.head === prHead;
}

const G10ReleaseInput = z.looseObject({ runId: z.string(), repo: z.string(), pr: z.number(), head: z.string(), verdict: G10VerdictSchema, reviewerProfile: z.string(), checks: z.looseObject({ head: z.string(), green: z.boolean() }) });
const G10ReleaseResult = z.looseObject({ released: z.boolean(), head: z.string(), verdict: G10VerdictSchema.optional() });

/** The hold is read after the PR head, and released only if it is still held under the reason that was judged, so a re-hold in between stands. */
export function g10ReleaseRoutes(deps: ShepherdDeps) {
  return [
    codeRoute(G10_RELEASE_STEP, deps.now, async (raw: unknown) => {
      const input = G10ReleaseInput.parse(raw);
      const prHead = (await deps.port.getPr(input.repo as RepoSlug, input.pr)).headSha;
      const store = deps.store.get();
      const registration = store.byRun(input.runId);
      const run = { held: registration?.held ?? false, holdReason: registration?.holdReason ?? null };
      const judged = satisfiesG10(run, input.verdict, prHead, input.checks, input.reviewerProfile);
      const released = judged && run.holdReason !== null && store.releaseIfHeld(input.runId, run.holdReason);
      return { released, head: prHead, ...(released && { verdict: input.verdict }) };
    }),
  ];
}

/** Marks a MERGE as the verdict of the reviewer Shepherd spawned with `profile`; an external, resumed or carried verdict has none. */
export function withReviewerProfile(verdict: Verdict, profile: string | undefined): Verdict {
  return verdict.kind === "MERGE" && profile !== undefined ? { ...verdict, reviewerProfile: profile } : verdict;
}

interface G10WorkflowRun {
  ctx: WorkflowContext;
  target: { repo: string; pr: number };
  reviews: ReadonlyMap<string, Verdict>;
  lastCi?: CiSnapshot;
}

const EvidenceRecord = z.looseObject({ record: z.looseObject({ head: z.string(), verdictLocator: G10VerdictSchema.shape.locator, reviewer: Identity, carry: z.unknown().optional() }) });

/** The verdict ref of a MERGE the reviewer wrote at exactly this head; a verdict carried over from another head has none. */
function mergeRefAt(verdict: Verdict | undefined, head: string): G10Verdict | undefined {
  if (verdict?.kind !== "MERGE") return undefined;
  const evidence = EvidenceRecord.safeParse(verdict.evidence);
  if (!evidence.success || evidence.data.record.carry != null || evidence.data.record.head !== head) return undefined;
  const { verdictLocator, reviewer } = evidence.data.record;
  return { value: "MERGE", head, reviewer, locator: verdictLocator };
}

/** Verdicts that already released a hold in this run; a replay rebuilds the set from the recorded steps, so a re-hold waits for a verdict not yet used. */
const used = new WeakMap<WorkflowContext, Set<string>>();

/** Records the release as a step, so `shepherd status` and the ledger show it; the route re-reads the PR head and the hold before it writes. */
export async function releaseG10Hold(run: G10WorkflowRun, holdReason: string | null | undefined): Promise<void> {
  const ci = run.lastCi;
  if (holdClassOf(holdReason) !== G10_REVIEW_CLASS || !ci) return;
  const merge = run.reviews.get(ci.headSha);
  const verdict = mergeRefAt(merge, ci.headSha);
  const reviewerProfile = merge?.kind === "MERGE" ? merge.reviewerProfile : undefined;
  const key = JSON.stringify([ci.headSha, verdict?.locator]);
  if (!verdict || reviewerProfile === undefined || !isOpusProfile(reviewerProfile) || used.get(run.ctx)?.has(key)) return;
  const attempt = run.ctx.iteration(G10_RELEASE_STEP);
  const input = { runId: run.ctx.runId, ...run.target, head: ci.headSha, verdict, reviewerProfile, checks: { head: ci.headSha, green: ci.verdict === "green" } };
  const done = await step(run.ctx, `${G10_RELEASE_STEP}:${ci.headSha}:${attempt}`, input, G10ReleaseResult);
  if (done.released) used.set(run.ctx, (used.get(run.ctx) ?? new Set()).add(key));
}
