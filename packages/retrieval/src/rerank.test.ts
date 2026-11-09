import { afterEach, describe, expect, it, vi } from "vitest";
import { crossEncoderReranker } from "./rerank.js";

afterEach(() => {
  vi.doUnmock("@huggingface/transformers");
});

describe("crossEncoderReranker default loader", () => {
  it("fails with the retrieval message when the transformers runtime has no pipeline", async () => {
    vi.doMock("@huggingface/transformers", () => ({}));

    const reranker = crossEncoderReranker();

    await expect(reranker.score("query", ["a", "b"])).rejects.toThrow(/supply your own Reranker/);
  });
});
