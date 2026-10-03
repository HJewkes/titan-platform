import { alwaysAskList } from "./always-ask.js";
import type { Route } from "./ledger.js";
import { normalizeKey } from "./normalize.js";
import { categoryPolicy, isLockedCategory, type DeciderMode, type RoutingPolicy } from "./policy.js";
import { DECIDABLE_CATEGORIES, unlockTableRow } from "./unlock.js";

export interface RouteQuestion {
  category: string;
  question: string;
  header?: string | null;
  options: readonly string[];
  initiative?: string | null;
}

export interface RouteContext {
  /** The asker's `AGENT_CHAT_AGENT_ID`; absent means an attended session. */
  agentId?: string | null;
  /** The asker cannot continue without the answer. */
  blocking?: "parked" | "none";
  /** The asker has other work it can do while it waits. */
  otherWork?: boolean;
}

export interface RouteDecision {
  route: Route;
  shadow: boolean;
  rule: 1 | 2 | 3 | 4;
  reason: string;
}

function hardStopHit(texts: readonly string[], hardStops: readonly string[]): string | undefined {
  const hay = normalizeKey(texts.join(" "));
  return hardStops.find((stop) => {
    const key = normalizeKey(stop);
    return key.length > 0 && hay.includes(key);
  });
}

function isHumanOnly(initiative: string | null | undefined, humanOnly: readonly string[]): boolean {
  if (initiative == null) return false;
  const key = normalizeKey(initiative);
  return key.length > 0 && humanOnly.some((name) => normalizeKey(name) === key);
}

/** Why rule 1 holds for this question, or undefined when it does not. */
function alwaysAskReason(q: RouteQuestion, policy: RoutingPolicy): string | undefined {
  if (isHumanOnly(q.initiative, policy.humanOnlyInitiatives)) return `initiative ${q.initiative} is human-only`;
  const list = alwaysAskList(policy.hardStops);
  if (isLockedCategory(q.category, list)) return `category ${q.category} is always-ask`;
  const texts = [q.header ?? "", q.question, ...q.options];
  const row = texts.map(unlockTableRow).find((r) => r !== undefined);
  if (row !== undefined) return `touches the unlock table (${row})`;
  const stop = hardStopHit(texts, policy.hardStops);
  return stop === undefined ? undefined : `matches hard stop "${stop}"`;
}

function ownerIsNeededNow(ctx: RouteContext): boolean {
  return (ctx.agentId == null || ctx.agentId === "") && ctx.blocking === "parked" && ctx.otherWork !== true;
}

/** Pure rule table, first match wins; never calls a model. A decider may narrow `decider`, never widen an owner route. */
export function route(question: RouteQuestion, policy: RoutingPolicy, ctx: RouteContext = {}): RouteDecision {
  const now = ownerIsNeededNow(ctx);
  const alwaysAsk = alwaysAskReason(question, policy);
  if (alwaysAsk !== undefined)
    return {
      route: now ? "owner-now" : "owner-queue",
      shadow: false,
      rule: 1,
      reason: alwaysAsk,
    };
  if (now)
    return {
      route: "owner-now",
      shadow: false,
      rule: 2,
      reason: "attended session is parked on this with no other work",
    };
  const { category, mode } = categoryPolicy(policy, question.category);
  const decidable = DECIDABLE_CATEGORIES.includes(category);
  if (mode === "auto" && decidable && question.options.length > 0)
    return { route: "decider", shadow: false, rule: 3, reason: `category ${category} is in auto mode` };
  return { route: "owner-queue", shadow: mode === "shadow", rule: 4, reason: queueReason(category, mode, decidable) };
}

function queueReason(category: string, mode: DeciderMode, decidable: boolean): string {
  if (mode !== "auto") return `category ${category} is in ${mode} mode`;
  return decidable
    ? `category ${category} is in auto mode but the question lists no options`
    : `category ${category} is not one a decider may answer`;
}
