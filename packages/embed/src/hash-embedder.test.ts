import { describe, expect, it } from "vitest";
import { HashEmbedder } from "./hash-embedder.js";
import { cosineSimilarity, norm } from "./vector.js";

describe("HashEmbedder", () => {
  it("is deterministic, fixed-width, and unit-length", async () => {
    const a = new HashEmbedder();
    const b = new HashEmbedder();
    const [va] = await a.embed(["Fix the failing vitest suite"]);
    const [vb] = await b.embed(["Fix the failing vitest suite"]);
    expect(va).toEqual(vb);
    expect(va).toHaveLength(256);
    expect(norm(va!)).toBeCloseTo(1, 6);
    expect(a.model).toBe("hash-v1-256");
  });

  it("scores lexically similar texts closer than unrelated ones", async () => {
    const e = new HashEmbedder({ dimensions: 512 });
    const [fix1, fix2, deploy] = await e.embed([
      "fix the failing vitest suite in packages/registry",
      "the vitest suite in packages/registry is failing, fix it",
      "deploy the cloudflare worker with wrangler",
    ]);
    expect(cosineSimilarity(fix1!, fix2!)).toBeGreaterThan(cosineSimilarity(fix1!, deploy!));
    expect(cosineSimilarity(fix1!, deploy!)).toBeLessThan(0.2);
  });

  it("handles empty input and empty text", async () => {
    const e = new HashEmbedder();
    expect(await e.embed([])).toEqual([]);
    const [empty] = await e.embed([""]);
    expect(empty!.every((x) => x === 0)).toBe(true);
  });

  it("rejects tiny dimension counts", () => {
    expect(() => new HashEmbedder({ dimensions: 4 })).toThrow(/>= 8/);
  });
});
