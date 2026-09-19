import { z } from "zod";

/** Open string: "repo" | "package" | "directory" | "file" | "symbol" today; consumers tolerate unknown kinds. */
export const NodeKind = z.string();

/** Open string: "error" | "warning" | "info" today. */
export const Severity = z.string();

export const ProvenanceKind = z.enum(["measured", "derived", "model"]);

export const Provenance = z.object({
  kind: ProvenanceKind,
  source: z.string(),
  at: z.string().optional(),
});

export const SnapshotInfo = z.object({
  id: z.number().int(),
  ref: z.string(),
  commit: z.string().nullable(),
  takenAt: z.string(),
  indexVersion: z.string(),
});

export const MetricDescriptor = z.object({
  name: z.string(),
  unit: z.string().nullable(),
  appliesTo: z.array(NodeKind),
  rollup: z.enum(["sum", "max", "mean", "none"]),
  direction: z.enum(["higher-worse", "lower-worse", "neutral"]),
  absent: z.enum(["zero", "exclude"]),
  window: z.string().optional(),
  description: z.string(),
  provenance: Provenance,
});

export const RuleSummary = z.object({ id: z.string(), type: z.string(), severity: Severity });

/** A snapshot id, a digit string, or a ref name meaning that ref's newest snapshot. Omitted means the newest overall. */
export const SnapshotRef = z.union([z.number().int().positive(), z.string().min(1)]);

export const Span = z.object({ startLine: z.number().int(), endLine: z.number().int() });

/** How a node is addressed everywhere in the API; consumers treat `id` as opaque and read the other fields. */
export const NodeRef = z.object({
  id: z.string(),
  kind: NodeKind,
  name: z.string(),
  /** The declaring file for a symbol, the directory path for a directory, "" for the repo. */
  path: z.string(),
  span: Span.optional(),
});

/** Open string: "no-rollup" | "not-measured" | "not-in-snapshot" today; why a value is null. */
export const MissingReason = z.string();

export const Capabilities = z.object({
  findings: z.enum(["none", "check-rules", "store"]),
  verdicts: z.boolean(),
  themes: z.boolean(),
  feedback: z.boolean(),
  embeddings: z.object({ model: z.string(), embedded: z.number(), symbols: z.number() }).nullable(),
  cochange: z.boolean(),
  sourceAtCommit: z.boolean(),
  excerpts: z.enum(["any", "flagged", "none"]),
});

export type ProvenanceKind = z.infer<typeof ProvenanceKind>;
export type Provenance = z.infer<typeof Provenance>;
export type SnapshotInfo = z.infer<typeof SnapshotInfo>;
export type MetricDescriptor = z.infer<typeof MetricDescriptor>;
export type RuleSummary = z.infer<typeof RuleSummary>;
export type Capabilities = z.infer<typeof Capabilities>;
export type SnapshotRef = z.infer<typeof SnapshotRef>;
export type Span = z.infer<typeof Span>;
export type NodeRef = z.infer<typeof NodeRef>;
