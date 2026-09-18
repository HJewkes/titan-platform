import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { Embedder } from "@titan-design/embed";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import { buildEmbedText, listEmbeddableSymbols } from "./corpus.js";
import { embedSnapshot, findSimilarCapability } from "./embeddings.js";

/** Deterministic embedder: looks vectors up by exact text, counts calls. */
function fakeEmbedder(
  vectors: Record<string, number[]>,
  model = "fake-model",
): Embedder & { embeddedTexts: string[] } {
  const embeddedTexts: string[] = [];
  return {
    model,
    dimensions: 4,
    embeddedTexts,
    embed: (texts) => {
      embeddedTexts.push(...texts);
      return Promise.resolve(
        texts.map((t) => {
          const v = vectors[t];
          if (!v) throw new Error(`fake embedder has no vector for: ${t}`);
          return [...v];
        }),
      );
    },
  };
}

const ALPHA_TEXT = "alpha(x: number): number -- Add one to a number";
const BETA_TEXT = "beta(): void";
const VECTORS: Record<string, number[]> = {
  [ALPHA_TEXT]: [2, 0, 0, 0], // deliberately un-normalized: the store must normalize
  [BETA_TEXT]: [0, 1, 0, 0],
  "add a number helper": [1, 0.2, 0, 0],
};

function insertFixture(db: CodeGraphStore, ref = "wd"): number {
  const snap = db.createSnapshot({ ref, indexVersion: "0.11.0" });
  db.insertNodes(snap, [
    { id: "src/a.ts", kind: "file", name: "a.ts" },
    { id: "src/b.test.ts", kind: "file", name: "b.test.ts", role: "test" },
    { id: "src/gen.ts", kind: "file", name: "gen.ts", role: "generated" },
    {
      id: "src/a.ts#alpha",
      kind: "symbol",
      name: "alpha",
      parentId: "src/a.ts",
      attrs: { exported: true, signature: "alpha(x: number): number", purpose: "Add one to a number" },
    },
    { id: "src/a.ts#beta", kind: "symbol", name: "beta", parentId: "src/a.ts", attrs: { exported: true, signature: "beta(): void" } },
    {
      id: "src/a.ts#internal",
      kind: "symbol",
      name: "internal",
      parentId: "src/a.ts",
      attrs: { exported: false, signature: "internal(): void" },
    },
    { id: "src/a.ts#noSig", kind: "symbol", name: "noSig", parentId: "src/a.ts", attrs: { exported: true } },
    {
      id: "src/b.test.ts#helper",
      kind: "symbol",
      name: "helper",
      parentId: "src/b.test.ts",
      attrs: { exported: true, signature: "helper(): void" },
    },
    { id: "src/gen.ts#genFn", kind: "symbol", name: "genFn", parentId: "src/gen.ts", attrs: { exported: true, signature: "genFn(): void" } },
  ]);
  return snap;
}

describe("embeddings", () => {
  let dbDir: string;
  let db: CodeGraphStore;

  beforeEach(async () => {
    dbDir = path.join(tmpdir(), `codewatch-emb-${Date.now()}-${Math.random()}`);
    await fs.mkdir(dbDir, { recursive: true });
    db = openCodeGraph(path.join(dbDir, "graph.db"));
  });

  afterEach(async () => {
    db.close();
    await fs.rm(dbDir, { recursive: true, force: true });
  });

  it("builds embed text as signature -- purpose, signature alone without", () => {
    expect(buildEmbedText("f(): void", "Does f")).toBe("f(): void -- Does f");
    expect(buildEmbedText("f(): void")).toBe("f(): void");
  });

  it("lists only exported, signatured, non-test, non-generated symbols", () => {
    const snap = insertFixture(db);
    const symbols = listEmbeddableSymbols(db, snap);
    expect(symbols.map((s) => s.id).sort()).toEqual(["src/a.ts#alpha", "src/a.ts#beta"]);
    const alpha = symbols.find((s) => s.id === "src/a.ts#alpha")!;
    expect(alpha.text).toBe(ALPHA_TEXT);
    expect(alpha.file).toBe("src/a.ts");
  });

  it("embeds a snapshot and reuses stored vectors on re-run", async () => {
    const snap = insertFixture(db);
    const embedder = fakeEmbedder(VECTORS);

    const first = await embedSnapshot(db, snap, embedder);
    expect(first).toMatchObject({ symbols: 2, withPurpose: 1, embedded: 2, newlyEmbedded: 2, reused: 0 });
    expect(embedder.embeddedTexts.sort()).toEqual([ALPHA_TEXT, BETA_TEXT]);

    const second = await embedSnapshot(db, snap, embedder);
    expect(second).toMatchObject({ embedded: 2, newlyEmbedded: 0, reused: 2 });
    expect(embedder.embeddedTexts).toHaveLength(2); // no further embed calls
  });

  it("reuses vectors across snapshots when texts are unchanged (content-addressed)", async () => {
    const snap1 = insertFixture(db, "wd");
    const embedder = fakeEmbedder(VECTORS);
    await embedSnapshot(db, snap1, embedder);

    const snap2 = insertFixture(db, "head");
    const result = await embedSnapshot(db, snap2, embedder);
    expect(result).toMatchObject({ newlyEmbedded: 0, reused: 2 });
  });

  it("ranks similar capabilities by cosine and reports coverage", async () => {
    const snap = insertFixture(db);
    const embedder = fakeEmbedder(VECTORS);
    await embedSnapshot(db, snap, embedder);

    const result = await findSimilarCapability(db, snap, "add a number helper", embedder);
    expect(result.coverage).toEqual({ symbols: 2, embedded: 2, withPurpose: 1 });
    expect(result.candidates.map((c) => c.id)).toEqual([
      "src/a.ts#alpha", // query vector points along alpha's axis
      "src/a.ts#beta",
    ]);
    expect(result.candidates[0]!.score).toBeGreaterThan(result.candidates[1]!.score);
    // stored vectors were L2-normalized despite the un-normalized fake output
    expect(result.candidates[0]!.score).toBeLessThanOrEqual(1.000001);
    expect(result.candidates[0]).toMatchObject({
      name: "alpha",
      file: "src/a.ts",
      signature: "alpha(x: number): number",
      purpose: "Add one to a number",
    });
  });

  it("respects the limit option", async () => {
    const snap = insertFixture(db);
    const embedder = fakeEmbedder(VECTORS);
    await embedSnapshot(db, snap, embedder);
    const result = await findSimilarCapability(db, snap, "add a number helper", embedder, { limit: 1 });
    expect(result.candidates).toHaveLength(1);
  });

  it("throws with guidance when no embeddings are stored for the model", async () => {
    const snap = insertFixture(db);
    const embedder = fakeEmbedder(VECTORS, "never-embedded-model");
    await expect(findSimilarCapability(db, snap, "anything", embedder)).rejects.toThrow(/embedSnapshot/);
  });
});
