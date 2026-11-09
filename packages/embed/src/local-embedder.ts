import { applyPrefix, resolvePrefixes, vectorSpaceId, type RolePrefixes } from "./prefixes.js";
import type { EmbedOptions, Embedder } from "./types.js";

export interface LocalEmbedderOptions {
  /** A Hugging Face model id with ONNX weights, e.g. `Xenova/bge-small-en-v1.5`. */
  model?: string;
  dimensions?: number;
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  /** Per-role prefixes; none by default except for nomic models. bge v1.5 takes an optional query instruction here. */
  prefixes?: Partial<RolePrefixes>;
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

/** The `pipeline` factory of `@huggingface/transformers`, typed loosely so each caller narrows its own task's result. */
export type TransformersPipeline = (task: string, model: string, options: { dtype: string }) => Promise<unknown>;

function isTransformersPipeline(value: unknown): value is TransformersPipeline {
  return typeof value === "function";
}

function isFeatureExtractor(value: unknown): value is FeatureExtractor {
  return typeof value === "function";
}

/**
 * Import the optional `@huggingface/transformers` peer and return its `pipeline` factory.
 * `missingMessage` is the caller's error text for an absent or malformed runtime.
 */
export async function loadTransformersPipeline(missingMessage: string): Promise<TransformersPipeline> {
  const name = "@huggingface/transformers";
  let mod: unknown;
  try {
    mod = await import(name);
  } catch (err) {
    throw new Error(missingMessage, { cause: err });
  }
  const pipeline = typeof mod === "object" && mod !== null && "pipeline" in mod ? mod.pipeline : undefined;
  if (!isTransformersPipeline(pipeline)) throw new Error(missingMessage);
  return pipeline;
}

async function defaultLoadPipeline(): Promise<PipelineFactory> {
  const pipeline = await loadTransformersPipeline(MISSING);
  return async (task, model, options) => {
    const extractor = await pipeline(task, model, options);
    if (!isFeatureExtractor(extractor)) throw new Error("@huggingface/transformers pipeline did not return a feature extractor");
    return extractor;
  };
}

/** In-process ONNX embeddings. Downloads the model on first use; weights are cached by the runtime. */
export class LocalEmbedder implements Embedder {
  readonly model: string;
  readonly modelName: string;
  readonly dimensions: number;
  readonly prefixes: RolePrefixes;
  private readonly dtype: string;
  private readonly loadPipeline: () => Promise<PipelineFactory>;
  private extractor: FeatureExtractor | null = null;

  constructor(options: LocalEmbedderOptions = {}) {
    this.modelName = options.model ?? "Xenova/bge-small-en-v1.5";
    this.prefixes = resolvePrefixes(this.modelName, options.prefixes);
    this.model = vectorSpaceId(this.modelName, this.prefixes);
    this.dimensions = options.dimensions ?? 384;
    this.dtype = options.dtype ?? "q8";
    this.loadPipeline = options.loadPipeline ?? defaultLoadPipeline;
  }

  async embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.extractor ??= await (await this.loadPipeline())("feature-extraction", this.modelName, { dtype: this.dtype });
    const output = await this.extractor(applyPrefix(texts, this.prefixes, options.role), { pooling: "mean", normalize: true });
    return output.tolist();
  }

  async dispose(): Promise<void> {
    await this.extractor?.dispose();
    this.extractor = null;
  }
}
