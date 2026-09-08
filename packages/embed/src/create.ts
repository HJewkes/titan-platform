import { HashEmbedder, type HashEmbedderOptions } from "./hash-embedder.js";
import { LocalEmbedder, type LocalEmbedderOptions } from "./local-embedder.js";
import { OllamaEmbedder, type OllamaEmbedderOptions } from "./ollama-embedder.js";
import type { Embedder } from "./types.js";

export type EmbedderConfig =
  | ({ backend: "hash" } & HashEmbedderOptions)
  | ({ backend: "ollama" } & OllamaEmbedderOptions)
  | ({ backend: "local" } & LocalEmbedderOptions);

export interface CreateEmbedderOptions {
  /**
   * Probe the backend once at creation and fall back to the hash embedder if
   * it fails. A startup decision, not a per-call one: the returned embedder's
   * `model` says which space you got, and vectors from two spaces never mix.
   */
  fallbackToHash?: boolean;
  onFallback?: (reason: Error) => void;
}

export function instantiateEmbedder(config: EmbedderConfig): Embedder {
  switch (config.backend) {
    case "hash":
      return new HashEmbedder(config);
    case "ollama":
      return new OllamaEmbedder(config);
    case "local":
      return new LocalEmbedder(config);
  }
}

export async function createEmbedder(config: EmbedderConfig, options: CreateEmbedderOptions = {}): Promise<Embedder> {
  const embedder = instantiateEmbedder(config);
  if (!options.fallbackToHash || config.backend === "hash") return embedder;
  try {
    const [probe] = await embedder.embed(["probe"]);
    if (probe?.length !== embedder.dimensions) {
      throw new Error(`${embedder.model} returned ${probe?.length ?? 0} dimensions, expected ${embedder.dimensions}`);
    }
    return embedder;
  } catch (err) {
    const reason = err instanceof Error ? err : new Error(String(err));
    options.onFallback?.(reason);
    await embedder.dispose?.().catch(() => undefined);
    return new HashEmbedder();
  }
}
