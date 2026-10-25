import { parseResultLine } from "@titan-design/fix-proof";
import type { CheckRun, GitHubPort } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import type { GateDecision, GateTarget } from "../gate-policy.js";
import { CHECKS_RECHECK_MS } from "../workflows/await-head.js";
import { deadline, type DeadlineTiming } from "../workflows/deadline.js";
import { codeRoute, step, type LandOptions } from "../workflows/land.js";
import { failureOf } from "./error-class.js";
import { DEFAULT_FIX_PROOF_WAIT_MS, FIX_PROOF_CHECK, LOG_TAIL_LINES, isFixProofRun, lastResultLine } from "./fix-proof.js";
import type { ShepherdDeps, Verdict } from "./phases.js";
import { mergeEvidenceAt } from "./policy.js";

export const REBOUND_PROOF_STEP = "sh-fix-proof-rebound";

/** fix-proof-run.sh's refusal. It shows a ref only in a plain ref alphabet, so the default branch it names ends at a space or `)`. */
const REFUSAL = /fix-proof runs only against the default branch: base \S+ is not ([^\s)]+)/;

const ReboundInput = z.object({ repo: z.string().min(1), pr: z.number().int().positive(), head: z.string().regex(/^[0-9a-f]{40}$/), into: z.string().min(1) });
type ReboundInput = z.infer<typeof ReboundInput>;
const ReboundResult = z.looseObject({ bound: z.boolean(), line: z.string().optional(), reason: z.string().optional() });
type Rebound = z.infer<typeof ReboundResult>;

type ReboundTiming = Omit<DeadlineTiming, "timeoutMs"> & { timeoutMs?: number; pollMs?: number };

/** The default branch a refused fix-proof standing names, or undefined for any other standing. */
function refusedInto(proofUnverified: string | undefined): string | undefined {
  return proofUnverified === undefined ? undefined : REFUSAL.exec(proofUnverified)?.[1];
}

function isRefusal(line: string): boolean {
  const parsed = parseResultLine(line);
  return parsed.ok && parsed.result.verdict === "error" && REFUSAL.test(parsed.result.error ?? "");
}

const boundTo = (input: ReboundInput) => (run: CheckRun) => run.status === "completed" && run.pullRequests.some((pr) => pr.number === input.pr && pr.baseRef === input.into);

/** The newest unread run's line that is no refusal; a run read once and found refused or lineless is not read again. */
async function lineOf(port: GitHubPort, input: ReboundInput, runs: readonly CheckRun[], spent: Set<number>): Promise<string | undefined> {
  for (const run of [...runs].sort((a, b) => b.id - a.id)) {
    if (spent.has(run.id)) continue;
    const line = lastResultLine(await port.jobLogTail(input.repo, run.id, LOG_TAIL_LINES), input.head);
    if (line !== undefined && !isRefusal(line)) return line;
    spent.add(run.id);
  }
  return undefined;
}

/** The refused run stays at the head beside any new one, so the wait is for a line that is no refusal, not for any completed run. */
async function readRebound(port: GitHubPort, input: ReboundInput, timing: ReboundTiming, signal: AbortSignal): Promise<Rebound> {
  const clock = deadline({ ...timing, timeoutMs: timing.timeoutMs ?? DEFAULT_FIX_PROOF_WAIT_MS });
  const spent = new Set<number>();
  for (;;) {
    const runs = (await port.checkRuns(input.repo, input.head)).filter((run) => isFixProofRun(input.head)(run) && boundTo(input)(run));
    const line = await lineOf(port, input, runs, spent);
    if (line !== undefined) return { bound: true, line };
    if (clock.expired()) return { bound: false, reason: `no ${FIX_PROOF_CHECK} run against ${input.into} printed a line at this head before the deadline` };
    await clock.sleep(timing.pollMs ?? CHECKS_RECHECK_MS, signal);
  }
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
 * head's fix-proof again until a run prints a line that is no refusal; until then an allow is a no-facts gate, which waits at the head.
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
    const reason = `the ${FIX_PROOF_CHECK} at ${head} was refused on a base that is not ${into}, and no ${FIX_PROOF_CHECK} line against ${into} has been read at this head`;
    return { outcome: "gate", rule: { table: "shepherd-merge-guard", rowId: "no-facts", version: 1 }, reason };
  };
  return { ...options, policy: { decide }, ...(options.unsettled && { unsettled: { ...options.unsettled, refresh } }) };
}
