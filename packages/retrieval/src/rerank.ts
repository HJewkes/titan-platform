/** Scores query/candidate pairs; higher is more relevant. Cross-encoders live here. */
export interface Reranker {
  readonly model: string;
  score(query: string, texts: string[]): Promise<number[]>;
}

export interface Candidate {
  id: string;
  text: string;
}

export interface Reranked extends Candidate {
  rerankScore: number;
}

/** Score every candidate and sort descending. Skipped for fewer than two candidates. */
export async function rerankCandidates(reranker: Reranker, query: string, candidates: Candidate[]): Promise<Reranked[]> {
  if (candidates.length < 2) return candidates.map((c) => ({ ...c, rerankScore: 1 }));
  const scores = await reranker.score(query, candidates.map((c) => c.text));
  return candidates.map((c, i) => ({ ...c, rerankScore: scores[i] ?? 0 })).sort((a, b) => b.rerankScore - a.rerankScore);
}

type Classifier = (pairs: [string, string][], options: { top_k: number }) => Promise<{ label: string; score: number }[]>;

export interface CrossEncoderOptions {
  model?: string;
  /** The cross-encoder's context window is ~512 tokens; longer texts are cut. */
  maxChars?: number;
  /** Injectable for tests; defaults to `@huggingface/transformers` (optional peer). */
  loadClassifier?: (model: string) => Promise<Classifier>;
}

const MISSING = "@huggingface/transformers is not installed; add it as a dependency or supply your own Reranker";

async function defaultLoadClassifier(model: string): Promise<Classifier> {
  const name = "@huggingface/transformers";
  let mod: { pipeline?: unknown };
  try {
    mod = (await import(name)) as { pipeline?: unknown };
  } catch (err) {
    throw new Error(MISSING, { cause: err });
  }
  if (typeof mod.pipeline !== "function") throw new Error(MISSING);
  const pipeline = mod.pipeline as (task: string, model: string, options: { dtype: string }) => Promise<Classifier>;
  return pipeline("text-classification", model, { dtype: "q8" });
}

/** In-process cross-encoder (default `Xenova/ms-marco-MiniLM-L-6-v2`), loaded on first use. */
export function crossEncoderReranker(options: CrossEncoderOptions = {}): Reranker {
  const model = options.model ?? "Xenova/ms-marco-MiniLM-L-6-v2";
  const maxChars = options.maxChars ?? 500;
  const load = options.loadClassifier ?? defaultLoadClassifier;
  let classifier: Promise<Classifier> | undefined;
  return {
    model,
    async score(query, texts) {
      classifier ??= load(model);
      const pairs = texts.map((t): [string, string] => [query, t.slice(0, maxChars)]);
      const out = await (await classifier)(pairs, { top_k: 1 });
      return out.map((o) => o.score);
    },
  };
}
