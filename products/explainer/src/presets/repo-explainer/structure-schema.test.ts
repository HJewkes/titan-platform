import { describe, expect, it } from "vitest";
import { ExplainerFactSchema } from "./schemas.js";
import { StructureSchema, type Structure } from "./structure-schema.js";

const SHA = "a".repeat(64);

function structure(overrides: Partial<Structure> = {}): Structure {
  return {
    schema: "structure/v1",
    snapshot: { id: 1, commit: "1".repeat(40), source: "fresh-index", files: 3 },
    levels: {
      map: { version: "repo-map/v1", sha: SHA, levels: [], nodes: [], edges: [], flows: [] },
      packages: [],
      directories: [],
    },
    centrality: [{ path: "a.ts", score: 0.3, rank: 1, of: 3 }],
    reading_order: [{ path: "a.ts", centrality: 0.3 }],
    entry_points: [{ path: "a.ts", from: "root" }],
    call_paths: [{ fact_id: "T-1", entry: "a.ts", target: "b.ts#f", path: ["a.ts#main", "b.ts#f"], via: "calls" }],
    edge_sources: ["import", "call"],
    ...overrides,
  };
}

const rx1Fact = {
  id: "T-1",
  source: "topic",
  kind: "feature",
  text: "A feature",
  evidence: [{ path: "a.ts", lineStart: 1, lineEnd: 2 }],
  tier: "store",
  verified: "yes",
  license_safe: true,
};

describe("StructureSchema", () => {
  it("parses a structure/v1 document and keeps the map's other fields", () => {
    const map = { ...structure().levels.map, width: 10 };

    const parsed = StructureSchema.parse(structure({ levels: { ...structure().levels, map } }));

    expect(parsed.levels.map).toMatchObject({ width: 10 });
  });

  it("rejects any other schema tag", () => {
    const result = StructureSchema.safeParse({ ...structure(), schema: "structure/v2" });

    expect(result.success).toBe(false);
  });

  it("rejects a call path that names a via but no path", () => {
    const call = { fact_id: "T-1", entry: "a.ts", target: "b.ts#f", path: null, via: "calls" as const };

    expect(StructureSchema.safeParse(structure({ call_paths: [call] })).success).toBe(false);
  });

  it("accepts an unreachable target as a null path with a null via", () => {
    const call = { fact_id: "T-1", entry: null, target: "b.ts#f", path: null, via: null };

    expect(StructureSchema.safeParse(structure({ call_paths: [call] })).success).toBe(true);
  });

  it("rejects a snapshot commit that is not a full sha", () => {
    const snapshot = { id: 1, commit: "abc", source: "fresh-index" as const, files: 3 };

    expect(StructureSchema.safeParse(structure({ snapshot })).success).toBe(false);
  });
});

describe("ExplainerFactSchema structure fields", () => {
  it("still parses an RX1 fact with no structure fields", () => {
    expect(ExplainerFactSchema.safeParse(rx1Fact).success).toBe(true);
  });

  it("accepts null centrality and reading rank for an unindexed fact", () => {
    const fact = { ...rx1Fact, centrality: null, reading_rank: null, shape_hints: { graph: false } };

    expect(ExplainerFactSchema.safeParse(fact).success).toBe(true);
  });

  it("rejects a centrality above 1 and a zero reading rank", () => {
    expect(ExplainerFactSchema.safeParse({ ...rx1Fact, centrality: 1.2 }).success).toBe(false);
    expect(ExplainerFactSchema.safeParse({ ...rx1Fact, reading_rank: 0 }).success).toBe(false);
  });
});
