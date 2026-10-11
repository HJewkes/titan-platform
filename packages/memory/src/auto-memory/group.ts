import { jaccard, tokenize } from "../text.js";
import type { DedupedFact, FactGroup } from "./types.js";
import { linkClusters } from "./union-find.js";

const DEFAULT_GROUP_THRESHOLD = 0.3;
const LABEL_TOKENS = 3;

// Words that link facts on phrasing rather than topic.
const STOP_WORDS = new Set([
  "a", "about", "after", "all", "always", "an", "and", "any", "are", "as", "at", "be", "before", "but", "by", "can",
  "do", "does", "don", "for", "from", "has", "have", "how", "if", "in", "into", "is", "it", "its", "never", "no",
  "not", "of", "on", "only", "or", "should", "so", "than", "that", "the", "their", "them", "then", "there", "they",
  "this", "to", "use", "via", "was", "what", "when", "which", "while", "who", "why", "will", "with", "without", "you",
]);

export interface GroupOptions {
  threshold?: number;
}

/** The topic tokens of a fact or skill: its tokenized name and description minus the stop list. */
export function topicTokens(text: string): Set<string> {
  const tokens = tokenize(text);
  for (const word of STOP_WORDS) tokens.delete(word);
  return tokens;
}

function factTopic({ fact }: DedupedFact): string {
  return [...topicTokens(`${fact.name} ${fact.description}`)].join(" ");
}

function label(facts: readonly DedupedFact[]): string {
  const counts = new Map<string, number>();
  for (const deduped of facts) for (const token of factTopic(deduped).split(" ").filter(Boolean)) counts.set(token, (counts.get(token) ?? 0) + 1);
  const ranked = [...counts].sort(([a, ca], [b, cb]) => cb - ca || compareText(a, b));
  return ranked.slice(0, LABEL_TOKENS).map(([token]) => token).join("-") || "untitled";
}

function firstPath(group: FactGroup): string {
  return group.facts[0]?.fact.ref.path ?? "";
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byPath(a: DedupedFact, b: DedupedFact): number {
  return compareText(a.fact.ref.path, b.fact.ref.path);
}

/** Single-link groups over topic-token Jaccard, largest first, then by label; stable for any input order. */
export function groupFacts(deduped: readonly DedupedFact[], options: GroupOptions = {}): FactGroup[] {
  const threshold = options.threshold ?? DEFAULT_GROUP_THRESHOLD;
  const topics = new Map(deduped.map((fact) => [fact, factTopic(fact)]));
  const linked = (a: DedupedFact, b: DedupedFact): boolean => {
    const [ta, tb] = [topics.get(a) ?? "", topics.get(b) ?? ""];
    return ta !== "" && tb !== "" && jaccard(ta, tb) >= threshold;
  };
  return linkClusters([...deduped].sort(byPath), linked)
    .map((facts) => ({ label: label(facts), facts }))
    .sort((a, b) => b.facts.length - a.facts.length || compareText(a.label, b.label) || compareText(firstPath(a), firstPath(b)));
}
