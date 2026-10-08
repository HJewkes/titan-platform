import type { RepoSlug } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step, type CiSnapshot } from "../workflows/land.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { MergeEvidenceSchema } from "./review-schemas.js";

export const G10_RELEASE_STEP = "sh-g10-release";
export const G10_RELEASE_STEPS: readonly StepDeclaration[] = [{ id: G10_RELEASE_STEP, kind: "dispatch" }];

/**
 * A hold's class is the text before the first colon of its reason. Only `g10-review` releases itself; `g10-adversary`
 * (authority, merge-policy and security PRs, until a seat's fail-open reviewer is Shepherd's) and every other class wait for a seat.
 */
const G10_REVIEW_CLASS = "g10-review";

export const holdClassOf = (reason: string | null | undefined): string | undefined => (reason?.includes(":") ? reason.slice(0, reason.indexOf(":")).trim() : undefined);

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

const G10ReleaseInput = z.looseObject({ runId: z.string(), repo: z.string(), pr: z.number(), head: z.string(), verdict: G10VerdictSchema, checks: z.looseObject({ head: z.string(), green: z.boolean() }) });
const G10ReleaseResult = z.looseObject({ released: z.boolean(), head: z.string(), verdict: G10VerdictSchema.optional() });

export function g10ReleaseRoutes(deps: ShepherdDeps, reviewProfile: string | undefined) {
  return [
    codeRoute(G10_RELEASE_STEP, deps.now, async (raw: unknown) => {
      const input = G10ReleaseInput.parse(raw);
      const store = deps.store.get();
      const registration = store.byRun(input.runId);
      const prHead = (await deps.port.getPr(input.repo as RepoSlug, input.pr)).headSha;
      const run = { held: registration?.held ?? false, holdReason: registration?.holdReason ?? null };
      const released = satisfiesG10(run, input.verdict, prHead, { head: input.checks.head, green: input.checks.green }, reviewProfile);
      if (released) store.release(input.runId);
      return { released, head: prHead, ...(released && { verdict: input.verdict }) };
    }),
  ];
}

interface G10WorkflowRun {
  ctx: WorkflowContext;
  target: { repo: string; pr: number };
  reviews: ReadonlyMap<string, Verdict>;
  lastCi?: CiSnapshot;
}

/** The verdict ref of a MERGE the reviewer wrote at exactly this head; a verdict carried over from another head has none. */
function mergeRefAt(verdict: Verdict | undefined, head: string): G10Verdict | undefined {
  if (verdict?.kind !== "MERGE") return undefined;
  const evidence = MergeEvidenceSchema.safeParse(verdict.evidence);
  if (!evidence.success || evidence.data.record.carry !== undefined || evidence.data.record.head !== head) return undefined;
  const { verdictLocator, reviewer } = evidence.data.record;
  return { value: "MERGE", head, reviewer, locator: verdictLocator };
}

/** Records the release as a step, so `shepherd status` and the ledger show it; the route re-reads the PR head and the hold before it writes. */
export async function releaseG10Hold(run: G10WorkflowRun, holdReason: string | null | undefined): Promise<void> {
  const ci = run.lastCi;
  if (holdClassOf(holdReason) !== G10_REVIEW_CLASS || !ci) return;
  const verdict = mergeRefAt(run.reviews.get(ci.headSha), ci.headSha);
  if (!verdict) return;
  const attempt = run.ctx.iteration(G10_RELEASE_STEP);
  const input = { runId: run.ctx.runId, ...run.target, head: ci.headSha, verdict, checks: { head: ci.headSha, green: ci.verdict === "green" } };
  await step(run.ctx, `${G10_RELEASE_STEP}:${ci.headSha}:${attempt}`, input, G10ReleaseResult);
}
