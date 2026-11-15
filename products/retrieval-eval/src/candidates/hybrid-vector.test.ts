import type { Embedder } from "@titan-design/embed";
import { describe, expect, it } from "vitest";
import type { Candidate } from "./candidate.js";
import { hybridVector, type NoteDocument } from "./hybrid-vector.js";

const LEXICAL_ONLY = "lexical-only";
const BOTH = "note:s/both.md";
const VECTOR_ONLY = "note:s/vector-only.md";

const documents: NoteDocument[] = [
  { ref: VECTOR_ONLY, text: "v".repeat(300) },
  { ref: BOTH, text: "b".repeat(300) },
];

/** Queries sit at [1, 0]; each document's vector is picked by its first letter. */
const stubEmbedder: Embedder = {
  model: "stub",
  dimensions: 2,
  async embed(texts) {
    return texts.map((text) => {
      if (text.startsWith("v")) return [1, 0];
      if (text.startsWith("b")) return [0.9, 0.436];
      return [1, 0];
    });
  },
};

function stubLexical(ids: string[]): Candidate {
  return {
    name: "stub-lexical",
    async search() {
      return ids.map((id) => ({ id, aliases: [], chars: 42 }));
    },
    close() {},
  };
}

async function build(name?: string): Promise<Candidate> {
  return hybridVector({
    activeRoot: "/root",
    lexical: stubLexical([LEXICAL_ONLY, BOTH]),
    embedder: stubEmbedder,
    documents,
    ...(name === undefined ? {} : { name }),
  });
}

const context = { arm: "spawn" } as const;

describe("hybridVector", () => {
  it("reports the name it was given", async () => {
    expect((await build("hybrid-bge-small")).name).toBe("hybrid-bge-small");
  });

  it("keeps the hybrid-fts-vector name when none is given", async () => {
    expect((await build()).name).toBe("hybrid-fts-vector");
  });

  it("ranks an id found by both lists above the top of a single list", async () => {
    const hits = await (await build()).search("query", 3, context);
    expect(hits.map((hit) => hit.id)[0]).toBe(BOTH);
  });

  it("gives a vector-only hit the excerpt char count", async () => {
    const hits = await (await build()).search("query", 3, context);
    expect(hits.find((hit) => hit.id === VECTOR_ONLY)?.chars).toBe(200);
  });
});
