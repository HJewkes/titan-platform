import { isFullSha } from "@titan-design/evidence";
import { z } from "zod";

export const STRUCTURE_SOURCES = ["review-index", "fresh-index"] as const;
export const EDGE_SOURCES = ["import", "call", "protocol"] as const;

const Count = z.number().int().min(0);
const Rank = z.number().int().min(1);
const Path = z.string().min(1);
const MapEdgeSource = z.enum(["import", "call", "protocol", "traced"]);

const MapFlowSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  hops: z.array(z.object({ step: Rank, edgeId: z.string().min(1), from: z.string(), to: z.string(), edgeSource: MapEdgeSource })),
  projected: z.record(z.string(), z.array(z.object({ from: z.string(), to: z.string() }))).optional(),
});

// graph-layout owns the full repo-map/v1 shape; this checks the fields RX2 writes and passes the rest through.
const MapLayoutSchema = z.looseObject({
  version: z.literal("repo-map/v1"),
  sha: z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 hex digest"),
  levels: z.array(z.object({ id: z.number().int(), name: z.string() })),
  nodes: z.array(z.looseObject({ id: z.string(), level: z.number().int() })),
  edges: z.array(z.looseObject({ id: z.string(), source: z.string(), target: z.string(), level: z.number().int() })),
  flows: z.array(MapFlowSchema),
});

// Summaries carry counts, never raw edges, so a script stage reads the shape without the graph.
const BoxSummarySchema = z.object({ id: z.string().min(1), label: z.string(), files: Count, edges_in: Count, edges_out: Count });

const FocusSchema = z.object({ package: z.string().min(1), files: z.array(Path), neighbours: z.array(z.string()), edges: Count });

const CallPathSchema = z
  .object({
    fact_id: z.string().min(1),
    entry: Path.nullable(),
    target: z.string().min(1),
    path: z.array(z.string().min(1)).min(1).nullable(),
    via: z.literal("calls").nullable(),
    flow_id: z.string().min(1).optional(),
  })
  .refine((call) => (call.path === null) === (call.via === null), { message: "path and via are both set or both null" });

export const StructureSchema = z.object({
  schema: z.literal("structure/v1"),
  snapshot: z.object({
    id: Rank,
    commit: z.string().refine(isFullSha, "expected a full 40-hex commit sha"),
    source: z.enum(STRUCTURE_SOURCES),
    files: Count,
  }),
  levels: z.object({
    map: MapLayoutSchema,
    packages: z.array(BoxSummarySchema),
    directories: z.array(BoxSummarySchema),
    focus: FocusSchema.optional(),
  }),
  centrality: z.array(z.object({ path: Path, score: z.number().nullable(), rank: Rank.nullable(), of: Count })),
  reading_order: z.array(z.object({ path: Path, centrality: z.number() })),
  entry_points: z.array(z.object({ path: Path, from: z.enum(["readme", "root"]) })),
  call_paths: z.array(CallPathSchema),
  edge_sources: z.array(z.enum(EDGE_SOURCES)),
});

export type Structure = z.infer<typeof StructureSchema>;
export type StructureSource = (typeof STRUCTURE_SOURCES)[number];
export type EdgeSource = (typeof EDGE_SOURCES)[number];
export type BoxSummary = z.infer<typeof BoxSummarySchema>;
export type FocusGraph = z.infer<typeof FocusSchema>;
export type CallPath = z.infer<typeof CallPathSchema>;
export type FileCentrality = Structure["centrality"][number];
export type EntryPoint = Structure["entry_points"][number];
