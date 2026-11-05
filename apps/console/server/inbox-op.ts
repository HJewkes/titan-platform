/**
 * An `owner-op` tap's read-back. A deposit's op names only the target, so everything the owner is shown comes from the
 * factory's `owner-op.preview`: GitHub's live head, title and base, the Shepherd hold, and the authority verdict. The op the
 * record posts is pinned to the head the preview read, never the deposit's, so a deposit that lies about a head reads back
 * the true one. A deploy-pause-clear is the exception: it is never re-pinned, so a newer pause than the deposit names has no
 * tap, and the factory re-checks the same pair. The deposit's own words are shown only as the proposal and who proposed it.
 *
 * On a g10-held PR a merge-at-head is two taps: the forced merge past the hold, or (`waitFor`) the owner's approval now with the
 * merge left to Shepherd once the adversary loop closes with MERGE at the same head.
 */
import type { MERGE_WAITS, OwnerItem, OwnerOp, OwnerOpKind } from "@titan-design/owner-queue";
import { holdClassOf } from "./gate-strip.js";
import type { InboxItem } from "./inbox-view.js";
import type { ActionOutcome } from "./owner-action.js";
import type { OpPreview, ShepherdSource } from "./shepherd.js";

export type OpAction = Extract<InboxItem["action"], { kind: "owner-op" }>;
export type MergeWait = (typeof MERGE_WAITS)[number];
type PrFacts = NonNullable<OpPreview["pr"]>;
type AgentFacts = NonNullable<OpPreview["agent"]>;
export type RetireOp = Extract<OwnerOp, { kind: "retire-agent" }>;

export type OpReadBack = PrOpReadBack | AgentOpReadBack | PauseReadBack;

interface Proposed {
  /** The authority row and verdict that let the console ask for this op, as the factory evaluated them, such as `MRG-OR: gate`. */
  authority: string;
  proposedBy: string;
  proposal: string;
  effect: string;
}

interface PrOpReadBack extends Proposed {
  repo: string;
  pr: number;
  title: string;
  headSha: string;
  base: string;
  behind: boolean;
  mergeableState: string;
  hold?: { class: string; reason: string };
  waitFor?: MergeWait;
}

/** A retire-agent op's read-back: the agent that holds the name now, as agent-chat's roster reads it. */
export interface AgentOpReadBack extends Proposed {
  agent: string;
  agentId: string;
  state: string;
  profile: string;
  cwd: string;
  spawnedBy: string | null;
  /** When its session exited, as agent-chat's roster reads it; null when the roster carries no exit time. */
  exitedAt: string | null;
}

/** The failure pause the factory reads now, which matches the deposit's, and the manual hold the clear leaves standing. */
interface PauseReadBack extends Proposed {
  pausedAt: string;
  target: string;
  why: string;
  rollback: string;
  manualHold?: string;
}

type PauseOp = Extract<OwnerOp, { kind: "deploy-pause-clear" }>;
type PauseFacts = NonNullable<OpPreview["pause"]>;

/** Each enabled kind's effect line; a kind missing here has no `owner-op` tap (`CONSOLE_OPS`). */
const EFFECT: Partial<Record<OwnerOpKind, (at: string) => string>> = {
  "merge-at-head": (at) => `Merge ${at} through a land run, once its required checks are green at this head`,
  "retire-agent": (at) => `Retire ${at}: release its worktree if it holds no uncommitted or unmerged work, and free the name. Its transcript stays on disk`,
  "close-pr": (at) => `Close ${at} on GitHub; the branch is kept and reopen is one click`,
  "deploy-pause-clear": (at) => `Clear the deploy pause from ${at}; the deploy pacer resumes and may deploy within about a minute`,
};

const forceEffect = (at: string, cwd: string): string =>
  `Retire ${at} with --force: discard what its worktree holds, remove the worktree at ${cwd}, and delete its branch locally. Pushed commits on origin are kept. This cannot be undone from the console`;

const FORCE_AT_TERMINAL = "a forced retire discards work, so it stays at the terminal";
/** What an older factory, whose preview reports no grace, means for a forced retire. */
const NO_FORCE_STOP = "the factory does not report agent-chat's grace, so a forced retire stays at the terminal";

const short = (sha: string): string => sha.slice(0, 7);

const G10_CLASSES: ReadonlySet<string> = new Set(["g10-review", "g10-adversary"]);
const isG10Hold = (hold: { class: string } | undefined): boolean => hold !== undefined && G10_CLASSES.has(hold.class);

const PAST_HOLD = "; the g10 hold is skipped, with whatever verdicts it still waits for";
const afterLoop = (at: string): string =>
  `Approve the merge of ${at} now; Shepherd merges it by itself once the adversary loop closes with MERGE at this head. A new head or a non-MERGE verdict voids the approval, and the inbox tells you`;

function holdOf(shepherd: PrFacts["shepherd"]): PrOpReadBack["hold"] {
  const reason = shepherd?.held === true ? shepherd.holdReason : (shepherd?.ownerHold ?? null);
  return reason === null ? undefined : { class: holdClassOf(reason) ?? "unclassed", reason };
}

const proposalOf = (item: OwnerItem) => ({ proposedBy: item.asker ?? "an agent", proposal: item.summary });

function factsOf(item: OwnerItem, pr: PrFacts & { head: string }, authority: string, effect: string): PrOpReadBack {
  const hold = holdOf(pr.shepherd);
  const { repo, base, behind, mergeableState } = pr;
  return { repo, pr: pr.pr, title: pr.title ?? item.summary, headSha: pr.head, base, behind, mergeableState, ...(hold && { hold }), authority, ...proposalOf(item), effect };
}

/** The read-back, or the reason there is nothing the console may do: the table denies the op, its target is gone, or the pause is not the deposit's. */
export async function opReadBackOf(shepherd: ShepherdSource, item: OwnerItem, { op }: OpAction, waitFor?: MergeWait): Promise<OpReadBack | string> {
  const effect = EFFECT[op.kind];
  if (effect === undefined) return `a ${op.kind} op has no console tap yet`;
  if (waitFor !== undefined && op.kind !== "merge-at-head") return `only a merge-at-head waits for the adversary loop, not a ${op.kind} op`;
  if (op.kind === "retire-agent") return op.force ? FORCE_AT_TERMINAL : (await retireReadOf(shepherd, op, proposalOf(item))).readBack;
  const preview = await shepherd.previewOp(op);
  const denied = deniedBy(op, preview);
  if (denied !== undefined) return denied;
  const authority = authorityOf(preview);
  if (op.kind === "deploy-pause-clear") return pauseReadBackOf(item, op, preview.pause, { authority, effect });
  const { pr } = preview;
  if (pr === undefined) return `the factory read no PR back for this ${op.kind} op`;
  if (pr.head === undefined) return `${pr.repo}#${pr.pr} is ${pr.state} on GitHub, so there is nothing to act on`;
  const facts = factsOf(item, { ...pr, head: pr.head }, authority, effect(`${pr.repo}#${pr.pr} at ${short(pr.head)}`));
  return op.kind === "merge-at-head" ? mergeFacts(facts, waitFor) : facts;
}

/** A g10 hold changes what a merge tap means: the forced merge says it skips the hold, and only a held PR has a loop to wait for. */
function mergeFacts(facts: PrOpReadBack, waitFor: MergeWait | undefined): PrOpReadBack | string {
  const held = isG10Hold(facts.hold);
  if (waitFor === undefined) return held ? { ...facts, effect: `${facts.effect}${PAST_HOLD}` } : facts;
  if (!held) return `${facts.repo}#${facts.pr} holds no g10 hold, so there is no adversary loop to wait for; merge at head instead`;
  return { ...facts, effect: afterLoop(`${facts.repo}#${facts.pr} at ${short(facts.headSha)}`), waitFor };
}

/** Why the authority table refuses the op to the console, or undefined when it does not. */
function deniedBy(op: OwnerOp, { authority: { verdict, ruleId, reason } }: OpPreview): string | undefined {
  return verdict === "deny" ? `the authority table refuses a ${op.kind} op to the console: ${reason ?? ruleId ?? "denied"}` : undefined;
}

const authorityOf = ({ authority: { verdict, ruleId } }: OpPreview): string => `${ruleId ?? "no rule"}: ${verdict}`;

/** A retire's read-back, and why a forced retire is refused now: null only once the agent's exit is past agent-chat's grace. */
interface RetireRead {
  readBack: AgentOpReadBack | string;
  forceStop: string | null;
}

/**
 * A retire's read-back from the factory's preview, for a deposit's op or the agent page's own (`retire-tap.ts`). Only the page
 * forces: a forced op reads back only while the factory's `forceStop` is null, so its read-back changes once that no longer holds.
 */
export async function retireReadOf(shepherd: ShepherdSource, op: RetireOp, proposed: Pick<Proposed, "proposedBy" | "proposal">): Promise<RetireRead> {
  const preview = await shepherd.previewOp(op);
  const reported = preview.agent?.forceStop;
  const forceStop = reported === undefined ? NO_FORCE_STOP : reported;
  const readBack = deniedBy(op, preview) ?? agentReadBackOf(op, preview.agent, { authority: authorityOf(preview), ...proposed });
  return { readBack: op.force && typeof readBack !== "string" && forceStop !== null ? forceStop : readBack, forceStop };
}

/** Offered only for the very agent the op names, once its session has exited and no live Shepherd run needs it. */
function agentReadBackOf(op: RetireOp, agent: AgentFacts | undefined, proposed: Omit<Proposed, "effect">): AgentOpReadBack | string {
  const holder = agent?.holder;
  if (agent === undefined || holder === undefined) return `no unretired agent holds the name ${op.name}, so there is nothing to retire`;
  if (holder.agentId !== op.agentId) return `${op.name} is now a different agent (${short(holder.agentId)}) than the one proposed`;
  if (!agent.exited) return `${op.name} is ${holder.state} (${holder.status}); retire a working agent at the terminal`;
  if (agent.liveRun !== null) return `${op.name} works on Shepherd run ${agent.liveRun}, which is still live`;
  const { agentId, state, profile, cwd, spawnedBy } = holder;
  const at = `${op.name} (${short(agentId)})`;
  const effect = op.force ? forceEffect(at, cwd) : EFFECT["retire-agent"]!(at);
  return { agent: op.name, agentId, state, profile, cwd, spawnedBy, exitedAt: holder.exitedAt ?? null, ...proposed, effect };
}

/** A tap is offered only for the very pause the deposit names, with no deployer running, as the factory's clear requires. */
function pauseReadBackOf(item: OwnerItem, op: PauseOp, pause: PauseFacts | undefined, { authority, effect }: { authority: string; effect: (at: string) => string }): PauseReadBack | string {
  if (pause === undefined) return "the factory read no deploy pause back for this deploy-pause-clear op";
  if (pause.paused === false) return "deploys are not paused by a rollback, so there is nothing to clear";
  const { since, lastRollback } = pause;
  if (since === null || lastRollback === null) return `the deploy pause cannot be read (${pause.reason ?? "unreadable"}); clear it on the terminal`;
  if (since !== op.pausedAt || lastRollback.target !== op.target) return `the deploy pause standing now is from ${since} over ${short(lastRollback.target)}; this deposit names the one from ${op.pausedAt}, so it is not cleared`;
  if (pause.deployerRunning) return "a deployer is running now; read the item again once it ends";
  const at = `${since} over ${short(lastRollback.target)}`;
  const said = pause.manualHold === null ? effect(at) : `Clear the deploy pause from ${at}; deploys stay held by hand (${pause.manualHold}), which this does not clear`;
  const hold = pause.manualHold === null ? {} : { manualHold: pause.manualHold };
  return { pausedAt: since, target: lastRollback.target, why: pause.reason ?? "no reason recorded", rollback: lastRollback.status, ...hold, authority, ...proposalOf(item), effect: said };
}

/** The op the record posts: the deposit's target at the head the owner was shown, waiting for the loop only when the owner chose to. */
export function postedOp(op: OwnerOp, readBack: OpReadBack): OwnerOp {
  if (!("headSha" in op && "pr" in op && "headSha" in readBack)) return op;
  if (op.kind !== "merge-at-head") return { ...op, headSha: readBack.headSha };
  return { kind: op.kind, repo: op.repo, pr: op.pr, headSha: readBack.headSha, ...(readBack.waitFor && { waitFor: readBack.waitFor }) };
}

type OpOutcome = Extract<ActionOutcome, { status: "accepted" | "approved" | "pr-closed" | "pause-cleared" | "retired" | "released" }>;

/** What a typed owner op's, or a hold release's, landed effect did. */
export function opMessageOf(outcome: OpOutcome): string {
  switch (outcome.status) {
    case "accepted":
      return `Merge queued: land run ${outcome.runId} merges at this head once its checks are green`;
    case "approved":
      return "Merge approved: Shepherd merges at this head once the adversary loop closes with MERGE; a new head or a non-MERGE verdict voids it and the inbox tells you";
    case "pr-closed":
      return `PR closed at ${short(outcome.closedHead)}; its branch is kept`;
    case "pause-cleared":
      return outcome.stillHeld === null ? "Deploy pause cleared; the deploy pacer may deploy within about a minute" : `Deploy pause cleared; deploys stay held by hand: ${outcome.stillHeld}`;
    case "retired":
      return [`Retired ${outcome.name}`, ...outcome.caveats].join("; ");
    case "released":
      return outcome.stillHeld === null ? "Hold released" : `Hold released; the PR is still held: ${outcome.stillHeld}`;
  }
}

export function movedMessage(outcome: Extract<ActionOutcome, { status: "moved" }>): string {
  if (outcome.currentAgentId !== undefined) return `The name is now a different agent (${short(outcome.currentAgentId)}), read again`;
  return outcome.currentPause === undefined ? `PR moved to ${outcome.currentHead === null ? "an unknown head" : short(outcome.currentHead)}, read again` : `A deploy pause from ${outcome.currentPause} stands instead and is kept, read again`;
}
