import { createHash } from "node:crypto";
import type { Embedder } from "./types.js";
import { normalize } from "./vector.js";

export interface HashEmbedderOptions {
  dimensions?: number;
}

/**
 * Zero-download fallback: feature hashing of word unigrams and bigrams into a
 * fixed-width bag, sign-hashed to spread collisions, L2-normalized. Not a
 * semantic model; it captures lexical overlap so pipelines keep working, and
 * degrades gracefully, when no real embedder is reachable. Deterministic across
 * processes and machines.
 */
export class HashEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;

  constructor({ dimensions = 256 }: HashEmbedderOptions = {}) {
    if (!Number.isInteger(dimensions) || dimensions < 8) throw new Error("dimensions must be an integer >= 8");
    this.dimensions = dimensions;
    this.model = `hash-v1-${dimensions}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const feature of features(text)) {
      const digest = createHash("sha256").update(feature, "utf8").digest();
      const index = digest.readUInt32LE(0) % this.dimensions;
      const sign = digest[4]! & 1 ? 1 : -1;
      vector[index]! += sign;
    }
    return normalize(vector);
  }
}

function features(text: string): string[] {
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const out = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}
