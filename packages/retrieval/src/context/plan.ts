export type DropReason = "over-budget" | "over-quota" | "duplicate" | "over-cap" | "no-tiers";

export interface ContextCandidate {
  id: string;
  category: string;
  score: number;
  /** Renderings from cheapest (tier 0) to richest. */
  tiers: string[];
}

export interface ContextBudget {
  tokens: number;
  quotas?: Record<string, number>;
  defaultQuota?: number;
  defaultTiers?: Record<string, number>;
  maxTier?: number;
  estimateTokens?: (text: string) => number;
}

export interface ContextEntry {
  id: string;
  category: string;
  tier: number;
  text: string;
  tokens: number;
  score: number;
}

export interface DroppedCandidate {
  id: string;
  category: string;
  reason: DropReason;
}

export interface ContextPlan {
  entries: ContextEntry[];
  dropped: DroppedCandidate[];
  usedTokens: number;
  budgetTokens: number;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Resolved {
  tokens: number;
  quotaOf(category: string): number;
  defaultTierOf(c: ContextCandidate): number;
  ceilingOf(c: ContextCandidate): number;
  cost(c: ContextCandidate, tier: number): number;
}

interface Working {
  candidate: ContextCandidate;
  tier: number;
  tokens: number;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number, got ${value}`);
  }
}

function lookup(table: Record<string, number> | undefined, key: string): number | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

function resolveBudget(budget: ContextBudget): Resolved {
  if (!Number.isInteger(budget.tokens) || budget.tokens < 0) {
    throw new RangeError(`tokens must be a non-negative integer, got ${budget.tokens}`);
  }
  for (const [category, quota] of Object.entries(budget.quotas ?? {})) requireFinite(quota, `quota for ${category}`);
  const defaultQuota = budget.defaultQuota ?? 1;
  requireFinite(defaultQuota, "defaultQuota");
  if (budget.maxTier !== undefined) requireFinite(budget.maxTier, "maxTier");
  const estimate = budget.estimateTokens ?? estimateTokens;
  const ceilingOf = (c: ContextCandidate): number => Math.min(c.tiers.length - 1, budget.maxTier ?? Infinity);
  return {
    tokens: budget.tokens,
    quotaOf: (category) => lookup(budget.quotas, category) ?? defaultQuota,
    defaultTierOf: (c) => Math.min(lookup(budget.defaultTiers, c.category) ?? 0, ceilingOf(c)),
    ceilingOf,
    cost: (c, tier) => estimate(c.tiers[tier] ?? ""),
  };
}

function byScore(candidates: readonly ContextCandidate[]): ContextCandidate[] {
  return [...candidates].sort((a, b) => b.score - a.score);
}

function fitReason(
  cost: number,
  used: number,
  categoryUsed: number,
  quotaTokens: number,
  budgetTokens: number,
): "over-budget" | "over-quota" | null {
  if (used + cost > budgetTokens) return "over-budget";
  if (categoryUsed + cost > quotaTokens) return "over-quota";
  return null;
}

interface BreadthState {
  placed: Working[];
  dropped: DroppedCandidate[];
  placedIds: Set<string>;
  categoryUsed: Map<string, number>;
  used: number;
}

function judge(candidate: ContextCandidate, state: BreadthState, r: Resolved): Working | DropReason {
  if (candidate.tiers.length === 0) return "no-tiers";
  if (state.placedIds.has(candidate.id)) return "duplicate";
  const tier = r.defaultTierOf(candidate);
  const tokens = r.cost(candidate, tier);
  const inCategory = state.categoryUsed.get(candidate.category) ?? 0;
  const reason = fitReason(tokens, state.used, inCategory, r.quotaOf(candidate.category) * r.tokens, r.tokens);
  return reason ?? { candidate, tier, tokens };
}

function place(w: Working, state: BreadthState): void {
  const category = w.candidate.category;
  state.placed.push(w);
  state.placedIds.add(w.candidate.id);
  state.categoryUsed.set(category, (state.categoryUsed.get(category) ?? 0) + w.tokens);
  state.used += w.tokens;
}

function breadthPass(sorted: ContextCandidate[], r: Resolved): { placed: Working[]; dropped: DroppedCandidate[] } {
  const state: BreadthState = { placed: [], dropped: [], placedIds: new Set(), categoryUsed: new Map(), used: 0 };
  for (const candidate of sorted) {
    const verdict = judge(candidate, state, r);
    if (typeof verdict === "string") state.dropped.push({ id: candidate.id, category: candidate.category, reason: verdict });
    else place(verdict, state);
  }
  return { placed: state.placed, dropped: state.dropped };
}

function fallbackTier(w: Working, cap: number, r: Resolved): number | null {
  for (let tier = w.tier - 1; tier >= 0; tier--) {
    if (r.cost(w.candidate, tier) <= cap) return tier;
  }
  return null;
}

function applyCap(placed: Working[], cap: number, r: Resolved): { kept: Working[]; dropped: DroppedCandidate[] } {
  const kept: Working[] = [];
  const dropped: DroppedCandidate[] = [];
  for (const w of placed) {
    if (w.tokens <= cap) {
      kept.push(w);
      continue;
    }
    const tier = fallbackTier(w, cap, r);
    if (tier === null) {
      dropped.push({ id: w.candidate.id, category: w.candidate.category, reason: "over-cap" });
    } else {
      kept.push({ candidate: w.candidate, tier, tokens: r.cost(w.candidate, tier) });
    }
  }
  return { kept, dropped };
}

function promote(w: Working, cap: number, leftover: number, r: Resolved): number | null {
  const next = w.tier + 1;
  if (next > r.ceilingOf(w.candidate)) return null;
  const cost = r.cost(w.candidate, next);
  if (cost > cap || cost - w.tokens > leftover) return null;
  return next;
}

function deepenPass(kept: Working[], cap: number, r: Resolved): void {
  let leftover = r.tokens - kept.reduce((sum, w) => sum + w.tokens, 0);
  for (const w of kept) {
    for (let next = promote(w, cap, leftover, r); next !== null; next = promote(w, cap, leftover, r)) {
      const tokens = r.cost(w.candidate, next);
      leftover -= tokens - w.tokens;
      w.tier = next;
      w.tokens = tokens;
    }
  }
}

function toPlan(kept: Working[], dropped: DroppedCandidate[], r: Resolved): ContextPlan {
  const entries = kept.map(
    (w): ContextEntry => ({
      id: w.candidate.id,
      category: w.candidate.category,
      tier: w.tier,
      text: w.candidate.tiers[w.tier] ?? "",
      tokens: w.tokens,
      score: w.candidate.score,
    }),
  );
  const usedTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
  return { entries, dropped, usedTokens, budgetTokens: r.tokens };
}

export function planContext(candidates: readonly ContextCandidate[], budget: ContextBudget): ContextPlan {
  const r = resolveBudget(budget);
  const { placed, dropped: breadthDrops } = breadthPass(byScore(candidates), r);
  if (placed.length === 0) return toPlan([], breadthDrops, r);
  const cap = (2 * r.tokens) / placed.length;
  const { kept, dropped: capDrops } = applyCap(placed, cap, r);
  deepenPass(kept, cap, r);
  return toPlan(kept, [...breadthDrops, ...capDrops], r);
}
