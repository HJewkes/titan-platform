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
import type { OpPreview, ShepherdSource } from "./shepherd.js";

export type OpAction = Extract<InboxItem["action"], { kind: "owner-op" }>;
export type MergeWait = (typeof MERGE_WAITS)[number];
type PrFacts = NonNullable<OpPreview["pr"]>;

export type OpReadBack = PrOpReadBack | PauseReadBack;

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
  "close-pr": (at) => `Close ${at} on GitHub; the branch is kept and reopen is one click`,
  "deploy-pause-clear": (at) => `Clear the deploy pause from ${at}; the deploy pacer resumes and may deploy within about a minute`,
};

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

function factsOf(item: OwnerItem, pr: PrFacts & { head: string }, authority: string, effect: string): PrOpReadBack {
  const hold = holdOf(pr.shepherd);
  const { repo, base, behind, mergeableState } = pr;
  return { repo, pr: pr.pr, title: pr.title ?? item.summary, headSha: pr.head, base, behind, mergeableState, ...(hold && { hold }), authority, proposedBy: item.asker ?? "an agent", proposal: item.summary, effect };
}

/** The read-back, or the reason there is nothing the console may do: the table denies the op, the PR has no open head, or the pause is not the deposit's. */
export async function opReadBackOf(shepherd: ShepherdSource, item: OwnerItem, { op }: OpAction, waitFor?: MergeWait): Promise<OpReadBack | string> {
  const effect = EFFECT[op.kind];
  if (effect === undefined) return `a ${op.kind} op has no console tap yet`;
  if (waitFor !== undefined && op.kind !== "merge-at-head") return `only a merge-at-head waits for the adversary loop, not a ${op.kind} op`;
  const preview = await shepherd.previewOp(op);
  const { verdict, ruleId, reason } = preview.authority;
  if (verdict === "deny") return `the authority table refuses a ${op.kind} op to the console: ${reason ?? ruleId ?? "denied"}`;
  const authority = `${ruleId ?? "no rule"}: ${verdict}`;
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
  return { pausedAt: since, target: lastRollback.target, why: pause.reason ?? "no reason recorded", rollback: lastRollback.status, ...hold, authority, proposedBy: item.asker ?? "an agent", proposal: item.summary, effect: said };
}

/** The op the record posts: the deposit's target at the head the owner was shown, waiting for the loop only when the owner chose to. */
export function postedOp(op: OwnerOp, readBack: OpReadBack): OwnerOp {
  if (!("headSha" in op && "pr" in op && "headSha" in readBack)) return op;
  if (op.kind !== "merge-at-head") return { ...op, headSha: readBack.headSha };
  return { kind: op.kind, repo: op.repo, pr: op.pr, headSha: readBack.headSha, ...(readBack.waitFor && { waitFor: readBack.waitFor }) };
}
