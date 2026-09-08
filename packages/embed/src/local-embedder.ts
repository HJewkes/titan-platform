import type { Embedder } from "./types.js";

export interface LocalEmbedderOptions {
  /** A Hugging Face model id with ONNX weights, e.g. `Xenova/bge-small-en-v1.5`. */
  model?: string;
  dimensions?: number;
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  /** Injectable for tests; defaults to importing `@huggingface/transformers`. */
  loadPipeline?: () => Promise<PipelineFactory>;
}

/** The slice of `@huggingface/transformers` this class uses, so the package can stay an optional peer. */
export interface FeatureExtractor {
  (texts: string[], options: { pooling: "mean"; normalize: boolean }): Promise<{ tolist(): number[][] }>;
  dispose(): Promise<void>;
}
export type PipelineFactory = (
  task: "feature-extraction",
  model: string,
  options: { dtype: string },
) => Promise<FeatureExtractor>;

const MISSING = "@huggingface/transformers is not installed; add it as a dependency or use the ollama/hash embedders";

async function defaultLoadPipeline(): Promise<PipelineFactory> {
  const name = "@huggingface/transformers";
  let mod: { pipeline?: unknown };
  try {
    mod = (await import(name)) as { pipeline?: unknown };
  } catch (err) {
    throw new Error(MISSING, { cause: err });
  }
  if (typeof mod.pipeline !== "function") throw new Error(MISSING);
  return mod.pipeline as PipelineFactory;
}

/** In-process ONNX embeddings. Downloads the model on first use; weights are cached by the runtime. */
export class LocalEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly dtype: string;
  private readonly loadPipeline: () => Promise<PipelineFactory>;
  private extractor: FeatureExtractor | null = null;

  constructor(options: LocalEmbedderOptions = {}) {
    this.model = options.model ?? "Xenova/bge-small-en-v1.5";
    this.dimensions = options.dimensions ?? 384;
    this.dtype = options.dtype ?? "q8";
    this.loadPipeline = options.loadPipeline ?? defaultLoadPipeline;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.extractor ??= await (await this.loadPipeline())("feature-extraction", this.model, { dtype: this.dtype });
    const output = await this.extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }

  async dispose(): Promise<void> {
    await this.extractor?.dispose();
    this.extractor = null;
  }
}
