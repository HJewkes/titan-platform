import { tokenize } from "../text.js";
import { averageLinkage } from "./average-linkage.js";
import { cosine, tfidfVectors } from "./tfidf.js";
import type { DedupedFact, FactGroup } from "./types.js";

// Measured on 303 real facts on 2026-10-11: 0.03 gave 51 groups (largest 22, 5 singletons), inside a passing band
// of about 0.02 to 0.035; single-link Jaccard had no threshold below 60 groups without one group of 200 or more.
export const DEFAULT_GROUP_THRESHOLD = 0.03;
export const MAX_GROUP_SIZE = 25;
const LABEL_TOKENS = 3;

// Words that link facts on phrasing rather than topic.
const STOP_WORDS = new Set([
  "a", "about", "after", "all", "always", "an", "and", "any", "are", "as", "at", "be", "before", "but", "by", "can",
  "do", "does", "don", "for", "from", "has", "have", "how", "if", "in", "into", "is", "it", "its", "never", "no",
  "not", "of", "on", "only", "or", "should", "so", "than", "that", "the", "their", "them", "then", "there", "they",
  "this", "to", "use", "via", "was", "what", "when", "which", "while", "who", "why", "will", "with", "without", "you",
]);

export interface GroupOptions {
  /** Average TF-IDF cosine at which two groups merge. */
  threshold?: number;
  /** No group grows past this many facts. */
  maxGroupSize?: number;
}

/** The topic tokens of a fact or skill: its tokenized name and description minus the stop list. */
export function topicTokens(text: string): Set<string> {
  const tokens = tokenize(text);
  for (const word of STOP_WORDS) tokens.delete(word);
  return tokens;
}

function factTokens({ fact }: DedupedFact): Set<string> {
  return topicTokens(`${fact.name} ${fact.description}`);
}

function factTopic(deduped: DedupedFact): string {
  return [...factTokens(deduped)].join(" ");
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

// A fact with no topic tokens never links, so it stays a singleton at any threshold.
function cluster(sorted: readonly DedupedFact[], threshold: number, maxSize: number): DedupedFact[][] {
  const topical = sorted.filter((fact) => factTokens(fact).size > 0);
  const untopical = sorted.filter((fact) => factTokens(fact).size === 0);
  const vectors = tfidfVectors(topical.map(factTokens));
  const similarity = (i: number, j: number): number => cosine(vectors[i] ?? new Map(), vectors[j] ?? new Map());
  return [...averageLinkage(topical, similarity, { threshold, maxSize }), ...untopical.map((fact) => [fact])];
}

/**
 * Average-linkage groups over the smoothed TF-IDF cosine of topic tokens, capped at `maxGroupSize`, largest
 * first, then by label; stable for any input order.
 */
export function groupFacts(deduped: readonly DedupedFact[], options: GroupOptions = {}): FactGroup[] {
  const { threshold = DEFAULT_GROUP_THRESHOLD, maxGroupSize = MAX_GROUP_SIZE } = options;
  return cluster([...deduped].sort(byPath), threshold, maxGroupSize)
    .map((facts) => ({ label: label(facts), facts }))
    .sort((a, b) => b.facts.length - a.facts.length || compareText(a.label, b.label) || compareText(firstPath(a), firstPath(b)));
}
