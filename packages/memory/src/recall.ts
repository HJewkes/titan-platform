import type { Embedder } from "@titan-design/embed";
import { gatherFailOpen, vectorRetriever, type Degradation, type VectorIndex } from "@titan-design/retrieval";
import { scorePlaybook } from "./playbook.js";
import type { PlaybookStore } from "./store.js";
import { tokenize } from "./text.js";
import type { BulletScope, ScoredBullet } from "./types.js";

export interface SemanticOptions {
  embedder: Embedder;
  index: VectorIndex;
  /** Share of relevance taken from vector similarity; the rest is keyword score. */
  weight?: number;
  timeoutMs?: number;
}

export interface RecallOptions {
  limit?: number;
  /** Extra tags to match on top of the query's own tokens. */
  tags?: string[];
  /** Keep bullets scoped `global` or to this scope. */
  scope?: BulletScope;
  now?: Date;
  /** Filter on relevance, not final score, so a low-confidence but topical bullet still surfaces. */
  minRelevance?: number;
  semantic?: SemanticOptions;
}

export interface RecalledBullet extends ScoredBullet {
  keywordScore: number;
  semanticScore: number | null;
  relevanceScore: number;
  finalScore: number;
}

export interface RecallResult {
  bullets: RecalledBullet[];
  antiPatterns: RecalledBullet[];
  deprecatedWarnings: RecalledBullet[];
  /** Why semantic scoring fell back to keywords, if it did. Never silent. */
  degraded: Degradation[];
}

const EXACT_TOKEN = 3;
const SUBSTRING = 1;
const TAG_MATCH = 5;
const SCORE_FLOOR = 0.1;

/**
 * cass-memory's `cm context`: keyword score blended with optional vector
 * similarity, multiplied by the bullet's floored confidence, so what comes back
 * is topical first and trusted second.
 */
export async function recall(store: PlaybookStore, query: string, options: RecallOptions = {}): Promise<RecallResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 10;
  const minRelevance = options.minRelevance ?? 0.1;
  const candidates = scorePlaybook(store, now, { includeRetired: true }).filter((b) => inScope(b, options.scope));
  const semantic = await semanticScores(query, candidates.length, options.semantic);
  const ranked = candidates
    .map((b) => rank(b, query, options, semantic))
    .filter((b) => b.relevanceScore >= minRelevance)
    .sort(byScore);
  const live = ranked.filter((b) => b.state !== "retired");
  return {
    bullets: live.filter((b) => !b.isNegative).slice(0, limit),
    antiPatterns: live.filter((b) => b.isNegative).slice(0, limit),
    deprecatedWarnings: ranked.filter((b) => b.state === "retired").slice(0, limit),
    degraded: semantic.degraded,
  };
}

function inScope(bullet: ScoredBullet, scope: BulletScope | undefined): boolean {
  return scope === undefined || bullet.scope === "global" || bullet.scope === scope;
}

export function keywordScore(content: string, tags: readonly string[], query: string, extraTags: readonly string[] = []): number {
  const contentTokens = tokenize(content);
  const lower = content.toLowerCase();
  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  let score = 0;
  for (const token of tokenize(query)) {
    if (contentTokens.has(token)) score += EXACT_TOKEN;
    else if (lower.includes(token)) score += SUBSTRING;
    if (tagSet.has(token)) score += TAG_MATCH;
  }
  for (const tag of extraTags) if (tagSet.has(tag.toLowerCase())) score += TAG_MATCH;
  return score;
}

interface SemanticScores {
  similarity: Map<string, number>;
  weight: number;
  degraded: Degradation[];
}

async function semanticScores(query: string, count: number, options: SemanticOptions | undefined): Promise<SemanticScores> {
  if (!options || count === 0) return { similarity: new Map(), weight: 0, degraded: [] };
  const retriever = vectorRetriever(options.embedder, options.index, { name: "memory-vector" });
  const { lists, degraded } = await gatherFailOpen([retriever], query, { limit: count, timeoutMs: options.timeoutMs });
  const similarity = new Map<string, number>();
  for (const hit of lists[0]?.hits ?? []) similarity.set(hit.id, hit.score ?? 0);
  return { similarity, weight: degraded.length === 0 ? (options.weight ?? 0.6) : 0, degraded };
}

function rank(bullet: ScoredBullet, query: string, options: RecallOptions, semantic: SemanticScores): RecalledBullet {
  const keyword = keywordScore(bullet.content, bullet.tags, query, options.tags);
  const similarity = semantic.similarity.get(bullet.id);
  const semanticScore = semantic.weight === 0 ? null : (similarity ?? 0);
  const relevanceScore = keyword * (1 - semantic.weight) + (semanticScore ?? 0) * semantic.weight;
  return { ...bullet, keywordScore: keyword, semanticScore, relevanceScore, finalScore: relevanceScore * Math.max(SCORE_FLOOR, bullet.effectiveScore) };
}

function byScore(a: RecalledBullet, b: RecalledBullet): number {
  return b.finalScore - a.finalScore || b.relevanceScore - a.relevanceScore || a.id.localeCompare(b.id);
}
