/**
 * An `owner-op` tap's read-back. A deposit's op names only the target, so everything the owner is shown comes from the
 * factory's `owner-op.preview`: GitHub's live head, title and base, the Shepherd hold, and the authority verdict. The op the
 * record posts is pinned to the head the preview read, never the deposit's, so a deposit that lies about a head reads back
 * the true one. The deposit's own words are shown only as the proposal and who proposed it.
 */
import type { OwnerItem, OwnerOp, OwnerOpKind } from "@titan-design/owner-queue";
import { holdClassOf, type InboxItem } from "./inbox-view.js";
import type { OpPreview, ShepherdSource } from "./shepherd.js";

export type OpAction = Extract<InboxItem["action"], { kind: "owner-op" }>;
type PrFacts = NonNullable<OpPreview["pr"]>;
type AgentFacts = NonNullable<OpPreview["agent"]>;
type RetireOp = Extract<OwnerOp, { kind: "retire-agent" }>;

interface PrOpReadBack {
  repo: string;
  pr: number;
  title: string;
  headSha: string;
  base: string;
  behind: boolean;
  mergeableState: string;
  hold?: { class: string; reason: string };
  /** The authority row and verdict that let the console ask for this op, as the factory evaluated them, such as `MRG-OR: gate`. */
  authority: string;
  proposedBy: string;
  proposal: string;
  effect: string;
}

/** A retire-agent op's read-back: the agent that holds the name now, as agent-chat's roster reads it. */
interface AgentOpReadBack {
  agent: string;
  agentId: string;
  state: string;
  profile: string;
  cwd: string;
  spawnedBy: string | null;
  authority: string;
  proposedBy: string;
  proposal: string;
  effect: string;
}

export type OpReadBack = PrOpReadBack | AgentOpReadBack;

/** Each enabled kind's effect line; a kind missing here has no `owner-op` tap (`CONSOLE_OPS`). */
const EFFECT: Partial<Record<OwnerOpKind, (at: string) => string>> = {
  "merge-at-head": (at) => `Merge ${at} through a land run, once its required checks are green at this head`,
  "retire-agent": (at) => `Retire ${at}: release its worktree if it holds no uncommitted or unmerged work, and free the name. Its transcript stays on disk`,
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

/** The read-back, or the reason there is nothing the console may do: the table denies the op, or its target is gone. */
export async function opReadBackOf(shepherd: ShepherdSource, item: OwnerItem, { op }: OpAction): Promise<OpReadBack | string> {
  const effect = EFFECT[op.kind];
  if (effect === undefined) return `a ${op.kind} op has no console tap yet`;
  if (op.kind === "retire-agent" && op.force) return "a forced retire discards work, so it stays at the terminal";
  const preview = await shepherd.previewOp(op);
  const { verdict, ruleId, reason } = preview.authority;
  if (verdict === "deny") return `the authority table refuses a ${op.kind} op to the console: ${reason ?? ruleId ?? "denied"}`;
  const authority = `${ruleId ?? "no rule"}: ${verdict}`;
  if (op.kind === "retire-agent") return agentReadBackOf(item, op, preview.agent, authority, effect);
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

/** The op the record posts: the deposit's target at the head the owner was shown. */
export const postedOp = (op: OwnerOp, readBack: OpReadBack): OwnerOp => ("headSha" in op && "pr" in op && "headSha" in readBack ? { ...op, headSha: readBack.headSha } : op);
