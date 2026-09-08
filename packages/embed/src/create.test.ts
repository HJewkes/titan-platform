import { describe, expect, it, vi } from "vitest";
import { createEmbedder } from "./create.js";
import { LocalEmbedder, type PipelineFactory } from "./local-embedder.js";
import { OllamaEmbedder } from "./ollama-embedder.js";

const okFetch = (embeddings: number[][]): typeof fetch =>
  vi.fn(async () => new Response(JSON.stringify({ embeddings }), { status: 200 })) as unknown as typeof fetch;

describe("OllamaEmbedder", () => {
  it("posts prefixed texts to /api/embed and returns the embeddings", async () => {
    const fetchImpl = okFetch([[1, 0], [0, 1]]);
    const e = new OllamaEmbedder({ url: "http://host:11434/", dimensions: 2, fetch: fetchImpl });
    expect(await e.embed(["a", "b"])).toEqual([[1, 0], [0, 1]]);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://host:11434/api/embed");
    expect(JSON.parse(init.body as string)).toEqual({ model: "nomic-embed-text", input: ["search_document: a", "search_document: b"] });
    expect(await e.embed([])).toEqual([]);
  });

  it("turns HTTP failures, count mismatches, and connection errors into clear errors", async () => {
    const bad = vi.fn(async () => new Response("nope", { status: 500, statusText: "Server Error" })) as unknown as typeof fetch;
    await expect(new OllamaEmbedder({ fetch: bad }).embed(["x"])).rejects.toThrow(/500 Server Error/);
    await expect(new OllamaEmbedder({ fetch: okFetch([]) }).embed(["x"])).rejects.toThrow(/returned 0 embeddings for 1/);
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(new OllamaEmbedder({ fetch: down }).embed(["x"])).rejects.toThrow(/Is Ollama running/);
  });
});

describe("LocalEmbedder", () => {
  it("loads the pipeline once, embeds with mean pooling, and disposes", async () => {
    const dispose = vi.fn(async () => undefined);
    const extractor = Object.assign(
      vi.fn(async (texts: string[], _options: unknown) => ({ tolist: () => texts.map(() => [0.5, 0.5]) })),
      { dispose },
    );
    const loadPipeline = vi.fn(async () => (async () => extractor) as unknown as PipelineFactory);
    const e = new LocalEmbedder({ dimensions: 2, loadPipeline });
    expect(await e.embed(["a"])).toEqual([[0.5, 0.5]]);
    expect(await e.embed(["b", "c"])).toHaveLength(2);
    expect(loadPipeline).toHaveBeenCalledTimes(1);
    expect(extractor.mock.calls[0]?.[1]).toEqual({ pooling: "mean", normalize: true });
    await e.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("explains a missing runtime instead of failing on import", async () => {
    const e = new LocalEmbedder({ loadPipeline: async () => Promise.reject(new Error("@huggingface/transformers is not installed")) });
    await expect(e.embed(["x"])).rejects.toThrow(/not installed/);
  });
});

describe("createEmbedder", () => {
  it("returns the requested backend when it answers the probe", async () => {
    const e = await createEmbedder({ backend: "ollama", dimensions: 2, fetch: okFetch([[1, 0]]) }, { fallbackToHash: true });
    expect(e).toBeInstanceOf(OllamaEmbedder);
  });

  it("falls back to the hash embedder when the probe fails or has the wrong width", async () => {
    const onFallback = vi.fn();
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const e = await createEmbedder({ backend: "ollama", fetch: down }, { fallbackToHash: true, onFallback });
    expect(e.model).toBe("hash-v1-256");
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Is Ollama running/) }));

    const narrow = await createEmbedder({ backend: "ollama", dimensions: 768, fetch: okFetch([[1, 0]]) }, { fallbackToHash: true });
    expect(narrow.model).toBe("hash-v1-256");
  });

  it("does not probe without fallback enabled", async () => {
    const fetchImpl = okFetch([[1, 0]]);
    await createEmbedder({ backend: "ollama", fetch: fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
