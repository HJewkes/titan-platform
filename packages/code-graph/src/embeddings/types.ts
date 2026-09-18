export interface EmbeddableSymbol {
  id: string;
  name: string;
  file: string;
  signature: string;
  purpose?: string;
  text: string;
  textHash: string;
}

export interface EmbedCoverage {
  /** Embeddable exported symbols in the snapshot. */
  symbols: number;
  /** How many symbols have a stored vector for this model. */
  embedded: number;
  /** How many carry docstring purpose text (where recall is strongest). */
  withPurpose: number;
}

export interface EmbedSnapshotResult extends EmbedCoverage {
  model: string;
  /** Unique new texts sent to the embedder (symbols can share a text). */
  newlyEmbedded: number;
  /** Symbols whose vector was already stored (content-addressed cache hits). */
  reused: number;
}

/** Outcome of the non-fatal indexing pass: a down backend is reported, never thrown. */
export type EmbedAttempt =
  | { ok: true; result: EmbedSnapshotResult }
  | { ok: false; model: string; error: string };

export interface SimilarCandidate {
  id: string;
  name: string;
  file: string;
  signature: string;
  purpose?: string;
  /** Cosine similarity to the query, in [-1, 1]. */
  score: number;
}

export interface SimilarResult {
  query: string;
  model: string;
  coverage: EmbedCoverage;
  candidates: SimilarCandidate[];
}

export interface FindSimilarOptions {
  limit?: number;
  /** Prepended to the query before embedding; defaults to retrieval's `search_query: ` for nomic models. */
  queryPrefix?: string;
}
