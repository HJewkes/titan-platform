import type { WorkflowContext } from "@titan-design/workflow";
import type { RepoSlug } from "@titan-design/github";
import { conflictDecision, sentBackDecision } from "../gate-brief.js";
import { AwaitHeadResult } from "../workflows/await-head.js";
import { step, type CiSnapshot, type LandOutcome } from "../workflows/land.js";
import { escalationReason, type Escalated } from "./route-table.js";
import { askAtHead } from "./stale-gates.js";

export interface PrTarget {
  repo: RepoSlug;
  pr: number;
}

/** What the run's owner gates read: its context, its pull request, and the wait counter the await-new-head steps number from. */
export interface GateRun {
  ctx: WorkflowContext;
  target: PrTarget;
  state: { waits: number };
  /** An owner-gated escalation whose gate the head moved past; it gates every head until the owner answers an approve-merge gate. */
  carried?: Escalated;
}

/** What `liveEscalation` reads: the carried row, the per-head rows, and the last CI read. */
type CiRead = Pick<CiSnapshot, "headSha" | "mergeableState">;

interface EscalationRun {
  carried?: Escalated;
  escalations: Map<string, Escalated>;
  lastCi?: CiRead;
}

/**
 * The escalation that gates `headSha`. A conflict row is dropped, and cleared, once that head reads mergeable: GitHub's
 * mergeability is the evidence the owner was asked about, so a head that is not dirty has no conflict to ask about.
 */
export function liveEscalation(run: EscalationRun, headSha: string): Escalated | undefined {
  if (resolvedAt(run.lastCi, headSha)) clearConflict(run, headSha);
  return run.carried ?? run.escalations.get(headSha);
}

// Only conflict rows go: a no-progress or runaway row at the same head is not about mergeability and still gates the merge.
function clearConflict(run: EscalationRun, headSha: string): void {
  if (run.carried?.escalation === "conflict") run.carried = undefined;
  if (run.escalations.get(headSha)?.escalation === "conflict") run.escalations.delete(headSha);
}

// An unknown or unread state keeps the conflict: GitHub computes mergeability lazily, so only a read state resolves it.
function resolvedAt(lastCi: CiRead | undefined, headSha: string): boolean {
  return lastCi?.headSha === headSha && lastCi.mergeableState !== "dirty" && lastCi.mergeableState !== "unknown";
}

/** Waits, with no gate, for the PR to show any other head; undefined lands the next round. */
export async function awaitNewHead(run: GateRun, headSha: string): Promise<undefined> {
  await step(run.ctx, `await-new-head:${run.state.waits++}`, { ...run.target, headSha }, AwaitHeadResult);
  return undefined;
}

/** A run that wakes agents. */
export interface WakeRun extends GateRun {
  /** Heads a wake's await-new-head saw replaced; replaying the run's wakes rebuilds it. */
  wokenPast: Set<string>;
}

/**
 * A wake at a head an earlier wake already saw replaced is a stale read of that head, so it waits for the head to
 * differ again instead of spending a repair and resuming an agent with nothing to do. False means wake as usual.
 */
export async function awaitedPast(run: WakeRun, headSha: string): Promise<boolean> {
  if (!run.wokenPast.has(headSha)) return false;
  await awaitNewHead(run, headSha);
  return true;
}

/** True when an agent took the wake; the run has then moved past `headSha`, unless that same head turned green. */
export function tookWake(run: WakeRun, headSha: string, outcome: { kind: string; sameHead?: true }): boolean {
  if (outcome.kind === "woken" && outcome.sameHead !== true) run.wokenPast.add(headSha);
  return outcome.kind === "woken";
}

/** `merge` waits for a head that resolves the conflict and lands it through the normal rounds; it trusts no head. */
export async function conflictGate(run: GateRun, headSha: string): Promise<LandOutcome | undefined> {
  const { repo, pr } = run.target;
  const reason = escalationReason("conflict", `mergeable_state is dirty at ${headSha} after a fixer's attempt`);
  const prompt = `Merge PR #${pr} in ${repo} at head ${headSha}? Policy shepherd-route/conflict: ${reason}. Answer merge to have Shepherd land the next resolved head, or abandon.`;
  const { schema, brief } = conflictDecision({ repo, pr, headSha, reason });
  const answered = await askAtHead(run.ctx, "approve-merge", prompt, { schema, brief });
  if (!answered) {
    // The head moved past the conflict: land reads the new head, and its owner gate is asked again there, not answered here.
    run.carried = { escalation: "conflict", detail: `mergeable_state was dirty at ${headSha} after a fixer's attempt`, carriedFrom: headSha };
    return undefined;
  }
  run.carried = undefined;
  const answer = schema.parse(answered.data);
  if (answer.decision === "abandon") return { kind: "stopped", reason: "abandoned", headSha, detail: "a human abandoned the PR at a conflict" };
  return awaitNewHead(run, headSha);
}

/** A human chooses between waiting for a fix and abandoning; a pushed head answers for them. Undefined lands the next round. */
export async function sentBackGate(run: GateRun, headSha: string, prompt: string, abandoned: string, situation = prompt): Promise<LandOutcome | undefined> {
  const { schema, brief } = sentBackDecision({ ...run.target, headSha, situation });
  const answered = await askAtHead(run.ctx, "sh-sent-back", prompt, { schema, brief });
  const answer = answered ? schema.parse(answered.data) : { decision: "await-new-head" };
  if (answer.decision === "abandon") return { kind: "stopped", reason: "abandoned", headSha, detail: abandoned };
  return awaitNewHead(run, headSha);
}
