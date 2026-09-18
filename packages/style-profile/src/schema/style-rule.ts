import { z } from "zod";

export const ExampleSchema = z.object({
  good: z.string().optional(),
  bad: z.string().optional(),
  source: z.string().optional(),
});

export const StabilitySchema = z.enum(["high", "medium", "low"]);

export const FixabilitySchema = z.enum([
  "safe",
  "maybe-incorrect",
  "requires-input",
  "not-fixable",
]);

export const StyleRuleSchema = z.object({
  convention: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
  ]),
  confidence: z.number().min(0).max(1),
  stability: StabilitySchema.optional(),
  fixability: FixabilitySchema.optional(),
  description: z.string().optional(),
  examples: z.array(ExampleSchema).optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export type StyleRule = z.infer<typeof StyleRuleSchema>;
export type Stability = z.infer<typeof StabilitySchema>;
export type Fixability = z.infer<typeof FixabilitySchema>;
