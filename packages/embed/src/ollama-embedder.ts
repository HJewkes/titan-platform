import type { Embedder } from "./types.js";

export interface OllamaEmbedderOptions {
  /** Ollama base URL; local by default. A remote Ollama is the same thing with a different host. */
  url?: string;
  model?: string;
  dimensions?: number;
  /** Prepended to every text. nomic-embed-text expects `search_document: ` for indexing. */
  prefix?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Talks to Ollama's `/api/embed` over plain HTTP, so there is no SDK to depend on. */
export class OllamaEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly prefix: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaEmbedderOptions = {}) {
    this.baseUrl = (options.url ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.model = options.model ?? "nomic-embed-text";
    this.dimensions = options.dimensions ?? 768;
    this.prefix = options.prefix ?? "search_document: ";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.post(texts.map((t) => `${this.prefix}${t}`));
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
        body: JSON.stringify({ model: this.model, input }),
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
