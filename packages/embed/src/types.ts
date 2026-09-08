export interface Embedder {
  /** Identifies the vector space. Cache and index keys must include it; vectors from different models never mix. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  dispose?(): Promise<void>;
}
