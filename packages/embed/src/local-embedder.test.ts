import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalEmbedder, loadTransformersPipeline } from "./local-embedder.js";

const MESSAGE = "synthetic missing-runtime message";

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
  }
  throw new Error("expected the promise to reject with an Error");
}

afterEach(() => {
  vi.doUnmock("@huggingface/transformers");
  vi.resetModules();
});

describe("loadTransformersPipeline", () => {
  it("throws the caller's message with the import failure as cause when the import fails", async () => {
    vi.doMock("@huggingface/transformers", () => {
      throw new Error("synthetic import failure");
    });

    const failure = await rejection(loadTransformersPipeline(MESSAGE));

    expect(failure.message).toBe(MESSAGE);
    expect(failure.cause).toBeInstanceOf(Error);
  });

  it("throws the caller's message when the module has no pipeline export", async () => {
    vi.doMock("@huggingface/transformers", () => ({ env: {} }));

    const failure = await rejection(loadTransformersPipeline(MESSAGE));

    expect(failure.message).toBe(MESSAGE);
    expect(failure.cause).toBeUndefined();
  });
});

describe("LocalEmbedder default loader", () => {
  it("rejects a pipeline result that is not a feature extractor", async () => {
    vi.doMock("@huggingface/transformers", () => ({ pipeline: async () => ({ not: "callable" }) }));

    const embedder = new LocalEmbedder();

    await expect(embedder.embed(["synthetic text"])).rejects.toThrow(
      "@huggingface/transformers pipeline did not return a feature extractor",
    );
  });
});
