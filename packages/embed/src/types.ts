/** What a text is for. Models trained with task prefixes embed a document and a query differently. */
export type EmbedRole = "document" | "query";

export interface EmbedOptions {
  /** Defaults to `document`. The embedder, not the caller, turns the role into model-specific text. */
  role?: EmbedRole;
}

export interface Embedder {
  /**
   * Identifies the vector space: the model plus any per-role prefixes it
   * applies. Cache and index keys must include it; vectors from different
   * spaces never mix.
   */
  readonly model: string;
  /** The backend's own model name, when it differs from `model`. */
  readonly modelName?: string;
  readonly dimensions: number;
  embed(texts: string[], options?: EmbedOptions): Promise<number[][]>;
  dispose?(): Promise<void>;
}
