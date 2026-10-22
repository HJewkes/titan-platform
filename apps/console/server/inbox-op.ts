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

export interface OpReadBack {
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

/** Each enabled kind's effect line; a kind missing here has no `owner-op` tap (`CONSOLE_OPS`). */
const EFFECT: Partial<Record<OwnerOpKind, (at: string) => string>> = {
  "merge-at-head": (at) => `Merge ${at} through a land run, once its required checks are green at this head`,
};

const short = (sha: string): string => sha.slice(0, 7);

function holdOf(shepherd: PrFacts["shepherd"]): OpReadBack["hold"] {
  const reason = shepherd?.held === true ? shepherd.holdReason : (shepherd?.ownerHold ?? null);
  return reason === null || reason === undefined ? undefined : { class: holdClassOf(reason) ?? "unclassed", reason };
}

function factsOf(item: OwnerItem, pr: PrFacts & { head: string }, authority: string, effect: string): OpReadBack {
  const hold = holdOf(pr.shepherd);
  const { repo, base, behind, mergeableState } = pr;
  return { repo, pr: pr.pr, title: pr.title ?? item.summary, headSha: pr.head, base, behind, mergeableState, ...(hold && { hold }), authority, proposedBy: item.asker ?? "an agent", proposal: item.summary, effect };
}

/** The read-back, or the reason there is nothing the console may do: the table denies the op, or the PR has no open head. */
export async function opReadBackOf(shepherd: ShepherdSource, item: OwnerItem, { op }: OpAction): Promise<OpReadBack | string> {
  const effect = EFFECT[op.kind];
  if (effect === undefined) return `a ${op.kind} op has no console tap yet`;
  const preview = await shepherd.previewOp(op);
  const { verdict, ruleId, reason } = preview.authority;
  if (verdict === "deny") return `the authority table refuses a ${op.kind} op to the console: ${reason ?? ruleId ?? "denied"}`;
  const { pr } = preview;
  if (pr === undefined) return `the factory read no PR back for this ${op.kind} op`;
  if (pr.head === undefined) return `${pr.repo}#${pr.pr} is ${pr.state} on GitHub, so there is nothing to act on`;
  return factsOf(item, { ...pr, head: pr.head }, `${ruleId ?? "no rule"}: ${verdict}`, effect(`${pr.repo}#${pr.pr} at ${short(pr.head)}`));
}

/** The op the record posts: the deposit's target at the head the owner was shown. */
export const postedOp = (op: OwnerOp, readBack: OpReadBack): OwnerOp => ("headSha" in op && "pr" in op ? { ...op, headSha: readBack.headSha } : op);
