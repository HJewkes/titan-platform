/** A text-summarization backend the product injects; `model` keys the stored summaries. */
export interface Summarizer {
  readonly model: string;
  summarize(prompt: string): Promise<string>;
}

export interface ConventionSymbol {
  name: string;
  signature: string;
  purpose?: string;
}

export interface ConventionArea {
  /** Stable over membership: `area-` plus a hash of the member file list. */
  id: string;
  /** Dominant directory of the members. */
  label: string;
  /** Member files, most-connected first. */
  files: string[];
  size: number;
  topSymbols: ConventionSymbol[];
  /** Hash of the summarizer prompt, which is the summary-cache key. */
  contentHash: string;
  summary?: string;
}

export interface ConventionCoverage {
  /** Non-generated indexed files in the snapshot. */
  files: number;
  /** Files inside a kept area; the rest are too small or isolated to summarize. */
  grouped: number;
  areas: number;
  summarized: number;
}

export interface ConventionMap {
  model: string;
  coverage: ConventionCoverage;
  areas: ConventionArea[];
}

export interface SummarizeConventionsResult extends ConventionMap {
  /** Cache misses sent to the summarizer on this call. */
  newlySummarized: number;
  /** Areas whose summary was already stored. */
  reused: number;
}

export interface ConventionMatch {
  id: string;
  label: string;
  summary: string;
  files: string[];
  size: number;
  /** Cosine similarity of the query to the area summary, in [-1, 1]. */
  score: number;
}

export interface ConventionQueryResult {
  query: string;
  model: string;
  embeddingModel: string;
  coverage: ConventionCoverage;
  matches: ConventionMatch[];
}

/** The cut level: how coarse the partition is and which areas are kept. */
export interface ConventionOptions {
  /** Coarse community count to merge down to; default scales with repo size. */
  targetCount?: number;
  /** Areas smaller than this stay ungrouped (not summarized). Default 3. */
  minSize?: number;
}

export interface FindConventionsOptions extends ConventionOptions {
  /** Matches returned. Default 3. */
  limit?: number;
}

export interface ConventionCorpus {
  areas: ConventionArea[];
  /** Summarizer prompt per area, keyed by the area's `contentHash`. */
  prompts: Map<string, string>;
  coverage: ConventionCoverage;
}
