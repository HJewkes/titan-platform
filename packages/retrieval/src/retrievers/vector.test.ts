import { OllamaEmbedder, type Embedder } from "@titan-design/embed";
import { describe, expect, it } from "vitest";
import { BruteForceVectorIndex, vectorRetriever } from "./vector.js";

function recordingOllama(): { embedder: OllamaEmbedder; inputs: string[][] } {
  const inputs: string[][] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    inputs.push(input);
    return new Response(JSON.stringify({ embeddings: input.map(() => [1, 0]) }), { status: 200 });
  }) as typeof fetch;
  return { embedder: new OllamaEmbedder({ dimensions: 2, fetch: fetchImpl }), inputs };
}

describe("vectorRetriever with the default nomic OllamaEmbedder", () => {
  it("sends the document and the query to the backend with exactly one prefix each", async () => {
    const { embedder, inputs } = recordingOllama();
    const index = new BruteForceVectorIndex();
    const [doc] = await embedder.embed(["the daemon watches the workspace"]);
    index.add("doc", doc!);

    await vectorRetriever(embedder, index).retrieve("what does the daemon watch?", { limit: 1 });

    expect(inputs).toEqual([
      ["search_document: the daemon watches the workspace"],
      ["search_query: what does the daemon watch?"],
    ]);
  });
});

describe("vectorRetriever prefix ownership", () => {
  it("hands the query to the embedder verbatim with role query, even for a nomic-named model", async () => {
    const calls: { texts: string[]; role: string | undefined }[] = [];
    const embedder: Embedder = {
      model: "nomic-embed-text",
      dimensions: 2,
      embed: async (texts, options) => (calls.push({ texts, role: options?.role }), texts.map(() => [1, 0])),
    };

    await vectorRetriever(embedder, new BruteForceVectorIndex()).retrieve("what does the daemon watch?", { limit: 1 });

    expect(calls).toEqual([{ texts: ["what does the daemon watch?"], role: "query" }]);
  });
});
