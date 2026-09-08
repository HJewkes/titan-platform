/** One candidate from one retriever. Lower `rank` is better; `score` is retriever-specific and optional. */
export interface Hit {
  id: string;
  rank: number;
  score?: number;
  /** Anything the retriever wants to hand downstream (a locator, a distance, a hop count). */
  payload?: Record<string, unknown>;
}

export interface RetrieveOptions {
  limit: number;
  signal?: AbortSignal;
}

/** A source of ranked candidates: FTS, vectors, graph expansion, a custom SQL query. */
export interface Retriever {
  readonly name: string;
  retrieve(query: string, options: RetrieveOptions): Promise<Hit[]>;
}

export interface FusedResult {
  id: string;
  score: number;
  /** Which retrievers contributed, so callers can explain a result. */
  sources: string[];
  /** Merged payloads, keyed by retriever name. */
  payloads: Record<string, Record<string, unknown>>;
}
