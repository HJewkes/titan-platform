import type { GitHubPort } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { GateDecision, GateTarget } from "../gate-policy.js";
import { codeRoute, step, type LandOptions } from "../workflows/land.js";
import { failureOf } from "./error-class.js";
import { FIX_PROOF_CHECK, REFUSAL, fixProofStanding, fixProofVerdict, readProofAt, standingReasonOf, type FixProofReadSchema, type PollTiming } from "./fix-proof.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { mergeEvidenceAt } from "./policy.js";

export const REBOUND_PROOF_STEP = "sh-fix-proof-rebound";

const ReboundInput = z.object({ repo: z.string().min(1), pr: z.number().int().positive(), head: z.string().regex(/^[0-9a-f]{40}$/), into: z.string().min(1) });
type ReboundInput = z.infer<typeof ReboundInput>;
const ReboundResult = z.looseObject({ bound: z.boolean(), line: z.string().optional(), reason: z.string().optional() });
type Rebound = z.infer<typeof ReboundResult>;

/** The default branch a refused fix-proof standing names, or undefined for any other standing. */
function refusedInto(proofUnverified: string | undefined): string | undefined {
  return proofUnverified === undefined ? undefined : REFUSAL.exec(proofUnverified)?.[1];
}

/** Why the read against `into` proves nothing, by the rules the first read's standing applies, or undefined when it stands. */
function whyNotStanding(read: z.infer<typeof FixProofReadSchema>, head: string): string | undefined {
  if (read.kind !== "result") return `it is ${read.kind}${typeof read.reason === "string" ? `: ${read.reason}` : ""}`;
  const noRepro = fixProofVerdict(read, head);
  if (noRepro !== undefined) return `its verdict is ${read.verdict}, which reproduces nothing`;
  const unverified = fixProofStanding(read, head)?.unverified;
  if (unverified === undefined) return undefined;
  const reason = standingReasonOf(read);
  return `it is ${unverified}${reason === undefined ? "" : `: ${reason}`}`;
}

/** The read the first fix-proof read takes, bound to `into` and waiting past the refused run, which stays at the head beside any new one. */
async function readRebound(port: GitHubPort, input: ReboundInput, timing: PollTiming, signal: AbortSignal): Promise<Rebound> {
  const target = { repo: input.repo, head: input.head, pr: input.pr, binding: { pr: input.pr, baseRef: input.into }, pastRefusal: true };
  const read = await readProofAt(port, target, timing, signal);
  const line = "line" in read && typeof read.line === "string" ? { line: read.line } : {};
  const why = whyNotStanding(read, input.head);
  if (why === undefined) return { bound: true, ...line };
  return { bound: false, ...line, reason: `the ${FIX_PROOF_CHECK} read against ${input.into} at ${input.head} does not stand: ${why}` };
}

export const reboundProofRoute = (deps: ShepherdDeps): StepRoute =>
  codeRoute(REBOUND_PROOF_STEP, deps.now, async (raw: unknown, signal, clock) => {
    try {
      return await readRebound(deps.port, ReboundInput.parse(raw), { now: deps.now, sleep: deps.sleep, pollMs: deps.pollMs, startedAt: clock.firstStartedAtMs }, signal);
    } catch (error) {
      signal.throwIfAborted();
      return { bound: false, reason: `the ${FIX_PROOF_CHECK} check could not be read: ${failureOf(error)}` };
    }
  });

/** A record that goes on past the evidence re-read to anything else was decided before this read existed, so a replay skips it. */
function recordsRebound(ctx: WorkflowContext): boolean {
  const next = ctx.historyNext();
  return next === undefined || next.startsWith(REBOUND_PROOF_STEP);
}

/**
 * A head whose fix-proof was refused on a stacked base proves nothing about a merge into the default branch the refusal names, and a
 * same-head retarget leaves the one read per head standing (TP-4259). Each evidence refresh before a decision on that branch reads the
 * head's fix-proof again until a run prints a line that is no refusal, and that line is judged as a first read there would judge it.
 * Until a line stands, an allow is a no-facts gate, which waits at the head.
 */
export function withReboundProof(options: LandOptions, target: { repo: string; pr: number }, verdictFor: (headSha: string) => Verdict | undefined, decidedBase: () => string | undefined): LandOptions {
  const reads = new Map<string, Rebound>();
  const owedInto = (headSha: string): string | undefined => {
    const into = refusedInto(mergeEvidenceAt(headSha, verdictFor)?.record.proofUnverified);
    return into !== undefined && into === decidedBase() && reads.get(headSha)?.bound !== true ? into : undefined;
  };
  const refresh = async (ctx: WorkflowContext, headSha: string): Promise<void> => {
    await options.unsettled?.refresh(ctx, headSha);
    const into = owedInto(headSha);
    if (into === undefined || !recordsRebound(ctx)) return;
    reads.set(headSha, await step(ctx, `${REBOUND_PROOF_STEP}:${headSha}`, { ...target, head: headSha, into }, ReboundResult));
  };
  const decide = (action: string, gated?: GateTarget): GateDecision => {
    const decision = options.policy.decide(action, gated);
    const head = gated?.headSha;
    const into = head === undefined ? undefined : owedInto(head);
    if (decision.outcome !== "allow" || into === undefined) return decision;
    const read = head === undefined ? undefined : reads.get(head);
    const unread = `the ${FIX_PROOF_CHECK} at ${head} was refused on a base that is not ${into}, and no ${FIX_PROOF_CHECK} line against ${into} has been read at this head`;
    const reason = read?.line !== undefined && read.reason !== undefined ? read.reason : unread;
    return { outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "no-facts", version: 1 }, reason };
  };
  return { ...options, policy: { decide }, ...(options.unsettled && { unsettled: { ...options.unsettled, refresh } }) };
}
