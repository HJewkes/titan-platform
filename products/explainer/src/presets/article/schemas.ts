import { z } from "zod";

/** Owner Q4 B: a quote on screen or in the narration stays short. Third-party text is quoted, never reproduced. */
export const QUOTE_MAX_WORDS = 25;

export const ARTICLE_FACT_KINDS = ["claim", "number", "figure"] as const;

const Point = z.object({ x: z.number(), y: z.number() }).strict();

export const FigureSeriesSchema = z.object({ id: z.string().min(1), label: z.string().min(1), points: z.array(Point).min(1) }).strict();
export type FigureSeries = z.infer<typeof FigureSeriesSchema>;

export const FigureDataSchema = z
  .object({
    kind: z.enum(["bar", "line"]),
    x: z.string().min(1),
    y: z.string().min(1),
    // A bar figure's x is the row's 1-based index; its category labels are kept here in row order.
    categories: z.array(z.string()).optional(),
    series: z.array(FigureSeriesSchema).min(1),
  })
  .strict();
export type FigureData = z.infer<typeof FigureDataSchema>;

/** One line of `facts.jsonl`: a claim or number with a verbatim quote checked against the text, or a figure's data. */
export const ArticleFactSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(ARTICLE_FACT_KINDS),
    text: z.string().min(1),
    source: z.object({ label: z.string().min(1), ref: z.string().min(1) }).strict(),
    quote: z.string().min(1).optional(),
    value: z.number().optional(),
    unit: z.string().min(1).optional(),
    figure: FigureDataSchema.optional(),
  })
  .strict();
export type ArticleFact = z.infer<typeof ArticleFactSchema>;

/** A claim proposed by a model pass or a hand edit; gather accepts it only when its quote is verbatim and short. */
export const ArticleClaimSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "expected a kebab-case claim id"),
    kind: z.enum(["claim", "number"]),
    text: z.string().min(1),
    quote: z.string().min(1),
    value: z.number().optional(),
    unit: z.string().min(1).optional(),
  })
  .strict()
  .refine((claim) => claim.kind !== "number" || claim.value !== undefined, { message: "a number claim carries its value" });
export type ArticleClaim = z.infer<typeof ArticleClaimSchema>;
