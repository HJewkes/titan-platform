import { applyPrefix, resolvePrefixes, vectorSpaceId, type RolePrefixes } from "./prefixes.js";
import type { EmbedOptions, Embedder } from "./types.js";

export interface OllamaEmbedderOptions {
  /** Ollama base URL; local by default. A remote Ollama is the same thing with a different host. */
  url?: string;
  model?: string;
  dimensions?: number;
  /** Per-role prefixes; each role left out takes the model's default (nomic's task prefixes, else none). */
  prefixes?: Partial<RolePrefixes>;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Talks to Ollama's `/api/embed` over plain HTTP, so there is no SDK to depend on. */
export class OllamaEmbedder implements Embedder {
  readonly model: string;
  readonly modelName: string;
  readonly dimensions: number;
  readonly prefixes: RolePrefixes;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaEmbedderOptions = {}) {
    this.baseUrl = (options.url ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.modelName = options.model ?? "nomic-embed-text";
    this.prefixes = resolvePrefixes(this.modelName, options.prefixes);
    this.model = vectorSpaceId(this.modelName, this.prefixes);
    this.dimensions = options.dimensions ?? 768;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async embed(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.post(applyPrefix(texts, this.prefixes, options.role));
    if (!response.ok) throw new Error(`Ollama embedding failed: ${response.status} ${response.statusText} (${this.baseUrl})`);
    const data = (await response.json()) as { embeddings?: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error(`Ollama returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} texts`);
    }
    return data.embeddings;
  }

  private async post(input: string[]): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.modelName, input }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`Ollama embedding timed out after ${this.timeoutMs}ms (${this.baseUrl})`);
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Ollama embedding failed: ${message}. Is Ollama running at ${this.baseUrl}?`);
    }
  }
}
