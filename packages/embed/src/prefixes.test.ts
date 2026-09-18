import { describe, expect, it, vi } from "vitest";
import { HashEmbedder } from "./hash-embedder.js";
import { LocalEmbedder, type PipelineFactory } from "./local-embedder.js";
import { OllamaEmbedder, type OllamaEmbedderOptions } from "./ollama-embedder.js";
import { NO_PREFIXES, NOMIC_PREFIXES, vectorSpaceId } from "./prefixes.js";

function recordingOllama(options: OllamaEmbedderOptions = {}): { embedder: OllamaEmbedder; sent: () => unknown[] } {
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    return new Response(JSON.stringify({ embeddings: input.map(() => [1, 0]) }), { status: 200 });
  });
  const embedder = new OllamaEmbedder({ dimensions: 2, ...options, fetch: fetchImpl as unknown as typeof fetch });
  return { embedder, sent: () => fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init.body))) };
}

function recordingLocal(model?: string): { embedder: LocalEmbedder; sent: string[][] } {
  const sent: string[][] = [];
  const extractor = Object.assign(
    async (texts: string[]) => (sent.push(texts), { tolist: () => texts.map(() => [1, 0]) }),
    { dispose: async () => undefined },
  );
  const loadPipeline = async () => (async () => extractor) as unknown as PipelineFactory;
  return { embedder: new LocalEmbedder({ model, dimensions: 2, loadPipeline }), sent };
}

describe("OllamaEmbedder prefixes", () => {
  it("sends a default nomic document and query with exactly one prefix each", async () => {
    const { embedder, sent } = recordingOllama();

    await embedder.embed(["the daemon"], { role: "document" });
    await embedder.embed(["what watches?"], { role: "query" });

    expect(sent()).toEqual([
      { model: "nomic-embed-text", input: ["search_document: the daemon"] },
      { model: "nomic-embed-text", input: ["search_query: what watches?"] },
    ]);
  });

  it("treats a role-less call as a document, as 0.1 did", async () => {
    const { embedder, sent } = recordingOllama();

    await embedder.embed(["the daemon"]);

    expect(sent()).toEqual([{ model: "nomic-embed-text", input: ["search_document: the daemon"] }]);
  });

  it("sends a non-nomic model's texts unprefixed and honours per-role overrides", async () => {
    const plain = recordingOllama({ model: "mxbai-embed-large" });
    const custom = recordingOllama({ prefixes: { query: "" } });

    await plain.embedder.embed(["q"], { role: "query" });
    await custom.embedder.embed(["q"], { role: "query" });
    await custom.embedder.embed(["d"]);

    expect(plain.sent()).toEqual([{ model: "mxbai-embed-large", input: ["q"] }]);
    expect(custom.sent().map((b) => (b as { input: string[] }).input)).toEqual([["q"], ["search_document: d"]]);
  });
});

describe("LocalEmbedder prefixes", () => {
  it("passes bge texts through unprefixed for both roles", async () => {
    const { embedder, sent } = recordingLocal();

    await embedder.embed(["doc"]);
    await embedder.embed(["query"], { role: "query" });

    expect(sent).toEqual([["doc"], ["query"]]);
  });

  it("applies nomic's task prefixes to a nomic ONNX model", async () => {
    const { embedder, sent } = recordingLocal("nomic-ai/nomic-embed-text-v1.5");

    await embedder.embed(["doc"]);
    await embedder.embed(["query"], { role: "query" });

    expect(sent).toEqual([["search_document: doc"], ["search_query: query"]]);
  });
});

describe("HashEmbedder roles", () => {
  it("embeds a query exactly as it embeds a document and keeps its model name", async () => {
    const e = new HashEmbedder();

    const [asDocument] = await e.embed(["fix the vitest suite"]);
    const [asQuery] = await e.embed(["fix the vitest suite"], { role: "query" });

    expect(asQuery).toEqual(asDocument);
    expect(e.model).toBe("hash-v1-256");
  });
});

describe("vector-space identity", () => {
  it("differs between prefix configurations of one model and keeps the raw name available", () => {
    const nomic = new OllamaEmbedder();
    const raw = new OllamaEmbedder({ prefixes: NO_PREFIXES });

    expect(nomic.model).not.toBe(raw.model);
    expect(nomic.model).toBe(vectorSpaceId("nomic-embed-text", NOMIC_PREFIXES));
    expect(nomic.modelName).toBe("nomic-embed-text");
    expect(raw.modelName).toBe("nomic-embed-text");
  });

  it("never equals the bare pre-0.2 model name, even with no prefixes", () => {
    expect(new OllamaEmbedder({ prefixes: NO_PREFIXES }).model).not.toBe("nomic-embed-text");
    expect(new LocalEmbedder().model).not.toBe("Xenova/bge-small-en-v1.5");
    expect(new OllamaEmbedder().model).toMatch(/^nomic-embed-text#p=[0-9a-f]{8}$/);
  });
});
