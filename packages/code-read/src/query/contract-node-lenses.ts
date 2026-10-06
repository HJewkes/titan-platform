import { z } from "zod";
import { NodeRef } from "./schemas.js";

export const NodeLens = z.enum(["exports", "score", "centrality", "coupling", "tests"]);

/** A declared symbol of the file; code-graph's dossier keeps the top 8 exported and the top 8 internal. */
export const ExportRow = z.object({
  name: z.string(),
  utilization: z.number(),
  /** The symbol's own cognitive complexity; null for a class, a type, or a re-export. */
  cognitive: z.number().nullable(),
  /** Distinct files that reference the symbol. */
  consumers: z.number().int(),
  exported: z.boolean(),
});

/** The hotspot score at the node's grain, with the factors it multiplies; the factors are absent at a score of 0. */
export const ScoreBreakdown = z.object({
  grain: z.enum(["file", "symbol"]),
  window: z.string(),
  score: z.number(),
  churn: z.number().optional(),
  complexity: z.number().optional(),
  recency: z.number().optional(),
  /** Symbol grain only. */
  utilization: z.number().optional(),
  /** 1 is the highest score; null at a score of 0. */
  rank: z.number().int().nullable(),
  /** Nodes of the grain with a non-zero score. */
  ranked: z.number().int(),
});

/** PageRank over files and structural edges, as the reading order ranks them; null for generated code, which it leaves out. */
export const Centrality = z.object({
  score: z.number().nullable(),
  rank: z.number().int().nullable(),
  /** Files in the reading order; every one of them has a rank. */
  of: z.number().int(),
});

export const CoupledPartners = z.object({
  /** False until co-change pairs are stored in the index; `partners` is then empty. */
  measured: z.boolean(),
  partners: z.array(z.object({ node: NodeRef, count: z.number().int() })),
});

export const LinkedTests = z.object({
  /** Test files linked by path convention, such as `a.test.ts` beside `a.ts`. */
  tests: z.array(NodeRef),
  /** The indexer's `linked_test_count`, which also counts tests linked by co-editing; null when the index holds no such metric. */
  indexedCount: z.number().int().nullable(),
  /** False until co-change pairs are stored, so `tests` holds path-linked tests only. */
  coEditMeasured: z.boolean(),
});

/** Each requested lens; null when it does not describe the node's kind. Only `score` describes symbols; none describes directories. */
export const NodeLenses = z.object({
  exports: z.array(ExportRow).nullable().optional(),
  score: ScoreBreakdown.nullable().optional(),
  centrality: Centrality.nullable().optional(),
  coupling: CoupledPartners.nullable().optional(),
  tests: LinkedTests.nullable().optional(),
});

export type NodeLens = z.infer<typeof NodeLens>;
export type NodeLenses = z.infer<typeof NodeLenses>;
