import { scoreBullet, type FeedbackEvent, type Maturity, type NewBullet, type PlaybookStore, type ScoredBullet } from "@titan-design/memory";

/** The shared domains; a principle that only holds in one initiative uses a per-initiative domain instead. */
export const PRINCIPLE_DOMAINS = ["agent_ops", "tech_design", "scope_priority", "session_control"] as const;
export type PrincipleDomain = (typeof PRINCIPLE_DOMAINS)[number];

const LEDGER_PREFIX = "ledger:";
const DOMAIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The `sessionRef` that ties a principle's evidence back to a ledger row. */
export function ledgerRef(key: string): string {
  return `${LEDGER_PREFIX}${key}`;
}

/** The ledger key behind a `sessionRef`, or null when the ref did not come from the ledger. */
export function ledgerKeyOf(sessionRef: string | null): string | null {
  return sessionRef?.startsWith(LEDGER_PREFIX) ? sessionRef.slice(LEDGER_PREFIX.length) : null;
}

/** A domain doubles as a file name under the principles directory, so it must be one plain path segment. */
export function assertDomain(domain: string): string {
  if (!DOMAIN_PATTERN.test(domain)) throw new Error(`invalid principle domain: ${JSON.stringify(domain)}`);
  return domain;
}

export interface NewPrinciple {
  rule: string;
  domain: string;
  /** Ledger keys of the owner answers the rule was drawn from. */
  citedKeys: readonly string[];
  isNegative?: boolean;
  reasoning?: string | null;
}

/** A principle is a memory bullet whose category is its domain and whose provenance is ledger keys. */
export function principleBullet(input: NewPrinciple): NewBullet {
  return {
    content: input.rule,
    category: assertDomain(input.domain),
    isNegative: input.isNegative ?? false,
    source: "learned",
    sourceSessions: [...new Set(input.citedKeys)].map((key) => ({ sessionRef: ledgerRef(key) })),
    reasoning: input.reasoning ?? null,
  };
}

export interface Principle {
  id: string;
  domain: string;
  rule: string;
  isNegative: boolean;
  maturity: Maturity;
  score: number;
  /** Newest helpful feedback, or null when no owner answer has confirmed it yet. */
  lastConfirmed: string | null;
  /** Ledger keys that support the rule: its citations, then confirming answers, newest last. */
  examples: string[];
  /** Ledger keys of owner answers that contradicted the rule. */
  counterExamples: string[];
}

function ledgerKeys(events: readonly FeedbackEvent[]): string[] {
  return events.map((e) => ledgerKeyOf(e.sessionRef)).filter((key): key is string => key !== null);
}

/** The view a decider and the rendered docs share: confidence is maturity plus decayed score. */
export function toPrinciple(bullet: ScoredBullet, events: readonly FeedbackEvent[]): Principle {
  const helpful = events.filter((e) => e.type === "helpful");
  const cited = bullet.sourceSessions.map((s) => ledgerKeyOf(s.sessionRef)).filter((key): key is string => key !== null);
  return {
    id: bullet.id,
    domain: bullet.category,
    rule: bullet.content,
    isNegative: bullet.isNegative,
    maturity: bullet.maturity,
    score: bullet.effectiveScore,
    lastConfirmed: helpful[helpful.length - 1]?.at ?? null,
    examples: [...new Set([...cited, ...ledgerKeys(helpful)])],
    counterExamples: [...new Set(ledgerKeys(events.filter((e) => e.type === "harmful")))],
  };
}

/** Every live principle, grouped by domain, scored as of `now`. */
export function principlesByDomain(store: PlaybookStore, now: Date): Map<string, Principle[]> {
  const feedback = store.feedbackByBulletId();
  const grouped = new Map<string, Principle[]>();
  for (const bullet of store.list()) {
    const events = feedback.get(bullet.id) ?? [];
    const principle = toPrinciple(scoreBullet(bullet, events, now), events);
    grouped.set(principle.domain, [...(grouped.get(principle.domain) ?? []), principle]);
  }
  return grouped;
}
