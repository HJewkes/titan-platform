import { isFullSha } from "@titan-design/evidence";
import { z } from "zod";

export const FACT_SOURCES = ["topic", "row", "claim", "summary", "digest", "readme"] as const;
export const FACT_KINDS = [
  "feature",
  "gotcha",
  "guard",
  "claim",
  "what-it-is",
  "entry-point",
  "read-first",
  "should-not",
  "integration-rec",
  "capability",
  "fact",
  "shape",
  "pain",
] as const;
export const VERIFIED_LEVELS = ["yes", "partial", "no", "docs"] as const;

export const FactSourceSchema = z.enum(FACT_SOURCES);
export const FactKindSchema = z.enum(FACT_KINDS);
export type FactSource = z.infer<typeof FactSourceSchema>;
export type FactKind = z.infer<typeof FactKindSchema>;

const Line = z.number().int().min(1);
const Count = z.number().int().min(0);

// Lines are optional because a digest or read-first fact cites a whole file; a half range is
// rejected so S9 never verifies a span it cannot bound.
export const EvidenceSpanSchema = z
  .object({ path: z.string().min(1), lineStart: Line.optional(), lineEnd: Line.optional() })
  .refine((span) => (span.lineStart === undefined) === (span.lineEnd === undefined), {
    message: "lineStart and lineEnd are both set or both absent",
  })
  .refine((span) => span.lineStart === undefined || span.lineEnd! >= span.lineStart, {
    message: "lineEnd is before lineStart",
  });
export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;

// Not strict: RX2 to RX4 extend a fact with centrality, module and tagger fields.
export const ExplainerFactSchema = z.object({
  id: z.string().min(1),
  source: FactSourceSchema,
  kind: FactKindSchema,
  text: z.string().min(1),
  evidence: z.array(EvidenceSpanSchema),
  tier: z.string(),
  priority: z.string().optional(),
  verdict: z.string().optional(),
  verified: z.enum(VERIFIED_LEVELS),
  rows: Count.optional(),
  rows_yes: Count.optional(),
  license_safe: z.boolean(),
  row_ids: z.array(z.string().min(1)).optional(),
  claim_status: z.string().optional(),
  group: z.string().optional(),
  captions: z.array(z.string()).optional(),
});
export type ExplainerFact = z.infer<typeof ExplainerFactSchema>;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a sha256 hex digest");

export const ReviewBundleSchema = z.object({
  schema: z.literal("review-bundle/v1"),
  repo: z.object({
    url: z.url(),
    sha: z.string().refine(isFullSha, "expected a full 40-hex commit sha"),
    clone: z.string().min(1),
  }),
  label: z.string().min(1),
  coverage: z.object({ unread: Count, line: z.string().min(1) }),
  licenses: z.array(z.object({ prefix: z.string(), license: z.string().min(1) })),
  cost_usd: z.number().min(0).optional(),
  files_sha256: z.record(z.string().min(1), Sha256),
  counts: z.partialRecord(FactSourceSchema, Count),
});
export type ReviewBundle = z.infer<typeof ReviewBundleSchema>;
