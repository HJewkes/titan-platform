import { DEFAULT_SONNET_FOR, type PanelMember, type ReviewTarget } from "@titan-design/review-panel";
import type { ReviewWorkflowPorts } from "./ports.js";
import type { HealKind } from "./retry-policy.js";
import type { ReviewOutcome } from "./types.js";

export type HealPorts = Pick<ReviewWorkflowPorts, "checkout" | "snapshot" | "headroom">;

/** What a heal acts on: the head under review and, for a headroom refusal, the member the spawn gate refused. */
export interface HealSubject {
  target: ReviewTarget;
  member?: PanelMember;
  /** The plan's premium-to-sonnet table; absent means review-panel's `DEFAULT_SONNET_FOR`. */
  sonnetFor?: Record<string, string>;
}

/** The decision shape that asks for heals; every other decision passes through `healOnce` untouched. */
export interface HealRequest {
  kind: "heal";
  heals: readonly HealKind[];
}

export type HealEffect =
  | { kind: "healed"; subject: HealSubject }
  | { kind: "stop"; outcome: ReviewOutcome }
  /** The heal has nothing to act on, such as a refused member with no sonnet fallback. */
  | { kind: "ineffective"; heal: HealKind };

/** `heals` names what was still asked for after the one pass, or the heal that could not act. */
export type HealPassResult<D> =
  | { kind: "decided"; decision: D; subject: HealSubject }
  | { kind: "stop"; outcome: ReviewOutcome }
  | { kind: "fixer"; key: "heal-ineffective"; heals: readonly HealKind[] };

const isHealRequest = (decision: { kind: string }): decision is HealRequest => decision.kind === "heal";

/** Under Shepherd a moved head is the caller's `head-moved` outcome, so only a standalone run asks for this heal. */
async function retarget(subject: HealSubject, ports: HealPorts): Promise<HealEffect> {
  const current = (await ports.snapshot.read(subject.target)).pr.headSha;
  if (current === subject.target.head) return { kind: "ineffective", heal: "retarget" };
  return { kind: "healed", subject: { ...subject, target: { ...subject.target, head: current } } };
}

function degradeHeadroom(subject: HealSubject): HealEffect {
  const { member } = subject;
  const sonnetFor = subject.sonnetFor ?? DEFAULT_SONNET_FOR;
  const sonnet = member !== undefined && Object.hasOwn(sonnetFor, member.profile) ? sonnetFor[member.profile] : undefined;
  if (member === undefined || member.degraded || sonnet === undefined) return { kind: "ineffective", heal: "degrade-headroom" };
  return { kind: "healed", subject: { ...subject, member: { ...member, profile: sonnet, degraded: true } } };
}

/** A held account is a hold, never a failure, so it stops the run rather than counting against any budget. */
async function awaitAccount(subject: HealSubject, ports: HealPorts): Promise<HealEffect> {
  const read = await ports.headroom.read();
  if (read.account === "available") return { kind: "healed", subject };
  const resetsAt = read.resetsAt === undefined ? {} : { resetsAt: read.resetsAt };
  return { kind: "stop", outcome: { kind: "account-hold", head: subject.target.head, ...resetsAt } };
}

export async function applyHeal(heal: HealKind, subject: HealSubject, ports: HealPorts): Promise<HealEffect> {
  switch (heal) {
    case "refresh-checkout":
      await ports.checkout.refresh(subject.target);
      return { kind: "healed", subject };
    case "degrade-headroom":
      return degradeHeadroom(subject);
    case "retarget":
      return retarget(subject, ports);
    case "await-account":
      return awaitAccount(subject, ports);
  }
}

/**
 * Runs the heals a decision asks for, each once and in order, then re-decides once. A heal that cannot act, or a
 * re-decision that still asks for a heal, goes to the fixer: a second pass would repeat a heal that already failed.
 */
export async function healOnce<D extends { kind: string }>(
  decision: D | HealRequest,
  subject: HealSubject,
  ports: HealPorts,
  decide: (subject: HealSubject) => Promise<D | HealRequest>,
): Promise<HealPassResult<D>> {
  if (!isHealRequest(decision)) return { kind: "decided", decision, subject };
  let healed = subject;
  for (const heal of decision.heals) {
    const effect = await applyHeal(heal, healed, ports);
    if (effect.kind === "stop") return effect;
    if (effect.kind === "ineffective") return { kind: "fixer", key: "heal-ineffective", heals: [heal] };
    healed = effect.subject;
  }
  const next = await decide(healed);
  if (isHealRequest(next)) return { kind: "fixer", key: "heal-ineffective", heals: next.heals };
  return { kind: "decided", decision: next, subject: healed };
}
