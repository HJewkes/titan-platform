import { measurementAuditSchema, metricsEntrySchema } from "@titan-design/health/metrics";
import { z } from "zod";

export const AuditInputSchema = measurementAuditSchema.shape.inputs;
export type AuditInput = z.infer<typeof AuditInputSchema>;
export type StoreRef = AuditInput["stores"][number];
export type SurfaceRef = AuditInput["surfaces"][number];

export const MetricSpecSchema = metricsEntrySchema.shape.metrics.element;
export type MetricQuery = NonNullable<z.infer<typeof MetricSpecSchema>["query"]>;
const QuestionSchema = measurementAuditSchema.shape.questions.element;
export type Question = z.infer<typeof QuestionSchema>;

export const LoadedSchema = z.object({ input: AuditInputSchema, prior: z.unknown(), codeRev: z.string(), at: z.string() });
export type Loaded = z.infer<typeof LoadedSchema>;

const TableSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  rows: z.number(),
  /** Per JSON column, the distinct top-level key families (`ci-wait:0:1` counts as `ci-wait`). */
  jsonKeys: z.record(z.string(), z.array(z.string())).optional(),
});

export const StoreInventorySchema = z.object({
  store: z.string(),
  kind: z.string(),
  error: z.string().optional(),
  tables: z.array(TableSchema).optional(),
  logClasses: z.array(z.object({ text: z.string(), count: z.number() })).optional(),
  /** False for a log whose lines carry no date, so nothing in it can be placed in time. */
  timestamped: z.boolean().optional(),
  keys: z.array(z.string()).optional(),
  lines: z.number().optional(),
});
export type StoreInventory = z.infer<typeof StoreInventorySchema>;
export const DataInventorySchema = z.object({ stores: z.array(StoreInventorySchema) });

export const EmitterInventorySchema = z.object({
  emitters: z.array(
    z.object({
      kind: z.enum(["store-write", "step", "gate", "log", "health-field"]),
      name: z.string(),
      at: z.string().regex(/:\d+$/, "cite file:line"),
      persisted: z.boolean(),
    }),
  ),
});

export const PurposeSchema = z.object({ purpose: z.string(), users: z.array(z.string()), questions: z.array(QuestionSchema).min(1) });

export const QuestionCheckSchema = z.object({ question: QuestionSchema, outputHash: z.string().optional(), error: z.string().optional() });
export type QuestionCheck = z.infer<typeof QuestionCheckSchema>;
export const QuestionChecksSchema = z.object({ checks: z.array(QuestionCheckSchema) });

export const ProposalSchema = z.object({ metrics: z.array(MetricSpecSchema).min(1) });

export const BaselineSchema = z.object({ value: z.number().nullable(), n: z.number().int().nonnegative(), error: z.string().optional() });
export type Baseline = z.infer<typeof BaselineSchema>;

export const SliceProposalSchema = z.object({
  title: z.string(),
  done_when: z.string(),
  estimate: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  metrics: z.array(z.string()),
  /** Question ids this slice makes answerable. */
  unblocks: z.array(z.number().int()),
});
export type SliceProposal = z.infer<typeof SliceProposalSchema>;
export const GapProposalSchema = z.object({ slices: z.array(SliceProposalSchema) });

export const SurfacePlanSchema = z.object({ reports: z.array(metricsEntrySchema.shape.reports.element) });

export const ReviewAnswerSchema = z.object({ decision: z.enum(["publish", "discard"]) });

export const PublishedSchema = z.object({ path: z.string(), report: z.unknown() });
