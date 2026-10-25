/**
 * An `owner-op` tap's read-back. A deposit's op names only the target, so everything the owner is shown comes from the
 * factory's `owner-op.preview`: GitHub's live head, title and base, the Shepherd hold, and the authority verdict. The op the
 * record posts is pinned to the head the preview read, never the deposit's, so a deposit that lies about a head reads back
 * the true one. A deploy-pause-clear is the exception: it is never re-pinned, so a newer pause than the deposit names has no
 * tap, and the factory re-checks the same pair. The deposit's own words are shown only as the proposal and who proposed it.
 */
import type { OwnerItem, OwnerOp, OwnerOpKind } from "@titan-design/owner-queue";
import { holdClassOf, type InboxItem } from "./inbox-view.js";
import type { OpPreview, ShepherdSource } from "./shepherd.js";

export type OpAction = Extract<InboxItem["action"], { kind: "owner-op" }>;
type PrFacts = NonNullable<OpPreview["pr"]>;
type AgentFacts = NonNullable<OpPreview["agent"]>;
type RetireOp = Extract<OwnerOp, { kind: "retire-agent" }>;

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
}

/** A retire-agent op's read-back: the agent that holds the name now, as agent-chat's roster reads it. */
interface AgentOpReadBack extends Proposed {
  agent: string;
  agentId: string;
  state: string;
  profile: string;
  cwd: string;
  spawnedBy: string | null;
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

const short = (sha: string): string => sha.slice(0, 7);

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
export async function opReadBackOf(shepherd: ShepherdSource, item: OwnerItem, { op }: OpAction): Promise<OpReadBack | string> {
  const effect = EFFECT[op.kind];
  if (effect === undefined) return `a ${op.kind} op has no console tap yet`;
  if (op.kind === "retire-agent" && op.force) return "a forced retire discards work, so it stays at the terminal";
  const preview = await shepherd.previewOp(op);
  const { verdict, ruleId, reason } = preview.authority;
  if (verdict === "deny") return `the authority table refuses a ${op.kind} op to the console: ${reason ?? ruleId ?? "denied"}`;
  const authority = `${ruleId ?? "no rule"}: ${verdict}`;
  if (op.kind === "retire-agent") return agentReadBackOf(item, op, preview.agent, authority, effect);
  if (op.kind === "deploy-pause-clear") return pauseReadBackOf(item, op, preview.pause, { authority, effect });
  const { pr } = preview;
  if (pr === undefined) return `the factory read no PR back for this ${op.kind} op`;
  if (pr.head === undefined) return `${pr.repo}#${pr.pr} is ${pr.state} on GitHub, so there is nothing to act on`;
  return factsOf(item, { ...pr, head: pr.head }, authority, effect(`${pr.repo}#${pr.pr} at ${short(pr.head)}`));
}

/** Offered only for the very agent the deposit names, once its session has exited and no live Shepherd run needs it. */
function agentReadBackOf(item: OwnerItem, op: RetireOp, agent: AgentFacts | undefined, authority: string, effect: (at: string) => string): AgentOpReadBack | string {
  const holder = agent?.holder;
  if (agent === undefined || holder === undefined) return `no unretired agent holds the name ${op.name}, so there is nothing to retire`;
  if (holder.agentId !== op.agentId) return `${op.name} is now a different agent (${short(holder.agentId)}) than the one proposed`;
  if (!agent.exited) return `${op.name} is ${holder.state} (${holder.status}); retire a working agent at the terminal`;
  if (agent.liveRun !== null) return `${op.name} works on Shepherd run ${agent.liveRun}, which is still live`;
  const { agentId, state, profile, cwd, spawnedBy } = holder;
  return { agent: op.name, agentId, state, profile, cwd, spawnedBy, authority, ...proposalOf(item), effect: effect(`${op.name} (${short(agentId)})`) };
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

/** The op the record posts: a PR op's target at the head the owner was shown; any other op exactly as deposited. */
export const postedOp = (op: OwnerOp, readBack: OpReadBack): OwnerOp => ("headSha" in op && "pr" in op && "headSha" in readBack ? { ...op, headSha: readBack.headSha } : op);
