import { z } from "zod";
import { StyleRuleSchema } from "./style-rule.js";

export const SCHEMA_VERSION = "1.0.0";

const CategorySchema = z.record(z.string(), StyleRuleSchema);

const IdiomSchema = z.object({
  name: z.string(),
  description: z.string(),
  frequency: z.number(),
  confidence: z.number().min(0).max(1),
  example: z.string().optional(),
});

const AntiPatternSchema = z.object({
  pattern: z.string(),
  reason: z.string(),
  deprecated: z.boolean().optional(),
});

const OverrideSchema = z.object({
  files: z.array(z.string()),
  naming: CategorySchema.optional(),
  structure: CategorySchema.optional(),
  documentation: CategorySchema.optional(),
  errorHandling: CategorySchema.optional(),
  formatting: CategorySchema.optional(),
  patterns: CategorySchema.optional(),
});

const SeverityThresholdsSchema = z.object({
  error: z.number().min(0).max(1),
  warn: z.number().min(0).max(1),
  info: z.number().min(0).max(1),
});

export const DEFAULT_SEVERITY_THRESHOLDS = {
  error: 0.85,
  warn: 0.60,
  info: 0.40,
} as const;

export const ProfileSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.string(),
  author: z.string(),
  generated: z.string(),
  sources: z.array(z.string()),

  naming: CategorySchema,
  structure: CategorySchema,
  documentation: CategorySchema,
  errorHandling: CategorySchema,
  formatting: CategorySchema,
  patterns: CategorySchema,

  idioms: z.object({
    detected: z.array(IdiomSchema),
  }),

  antiPatterns: z.object({
    acknowledged: z.array(AntiPatternSchema),
  }),

  overrides: z.array(OverrideSchema),

  severityThresholds: SeverityThresholdsSchema.default(DEFAULT_SEVERITY_THRESHOLDS),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type SeverityThresholds = z.infer<typeof SeverityThresholdsSchema>;

export const PROFILE_CATEGORIES = [
  "naming",
  "structure",
  "documentation",
  "errorHandling",
  "formatting",
  "patterns",
] as const;

export type ProfileCategory = (typeof PROFILE_CATEGORIES)[number];

export type Severity = "error" | "warn" | "info" | "off";
