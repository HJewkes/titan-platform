import { z } from "zod";

export const BY_REC_POLICY_SCHEMA = "titan/auto-by-rec-policy@1";
export const BY_REC_ROW_SCHEMA = "titan/auto-by-rec@1";
export const BY_REC_MODES = ["off", "shadow", "live"] as const;
export const BY_REC_SOURCES = ["gate", "round", "deposit"] as const;
/** `overruled` is the owner's later pick against a live `resolved` row (TP-6778); only it carries `overrule`. */
export const BY_REC_RESULTS = ["would-resolve", "resolved", "skipped", "failed", "overruled"] as const;
/** The fields a policy exclusion can name; `hold`, `path` and `authority` match by prefix, the rest exactly. */
export const BY_REC_EXCLUDE_FIELDS = ["source", "id", "class", "hold", "category", "by", "path", "authority"] as const;

/** Who an auto-by-rec resolution is attributed to: never the owner, never a coordinator delegate. */
export const BY_REC_RESOLVER = Object.freeze({ class: "automation", id: "auto-by-rec" } as const);

const timestamp = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1).max(500);

const exclusionSchema = z.strictObject({
  field: z.enum(BY_REC_EXCLUDE_FIELDS),
  value: z.string().trim().min(1).max(200),
  note: text.optional(),
});

/**
 * The owner's policy file. It can turn the sweeps off, lengthen or shorten the wait, set a confidence floor and add
 * exclusions. Strict, so a file that tries to allow or unlist a floor class fails to parse rather than being ignored.
 */
export const byRecPolicySchema = z.strictObject({
  schema: z.literal(BY_REC_POLICY_SCHEMA),
  mode: z.enum(BY_REC_MODES).default("shadow"),
  afterHours: z.number().int().min(1).max(720).default(24),
  minConfidence: z.number().min(0).max(1).optional(),
  exclude: z.array(exclusionSchema).max(200).default([]),
});

const recommendationSchema = z.strictObject({
  answer: z.string().min(1),
  by: z.string().min(1),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});

/** The owner's own pick on an overruled row, and the owner-remote surface it came through. */
const overruleSchema = z.strictObject({
  answer: z.string().min(1),
  by: z.strictObject({ class: z.literal("owner-remote"), id: z.string().min(1), channel: z.string().min(1) }),
});

/** One auto-by-rec decision, written once per subject and mode: the facts read, what was done and why. */
const rowFields = z.strictObject({
  schema: z.literal(BY_REC_ROW_SCHEMA),
  subject: z.strictObject({ source: z.enum(BY_REC_SOURCES), id: z.string().min(1), summary: text.optional() }),
  recommendation: recommendationSchema,
  openedAt: timestamp,
  resolvedAt: timestamp,
  facts: z.record(z.string(), z.json()),
  mode: z.enum(["shadow", "live"]),
  result: z.enum(BY_REC_RESULTS),
  reason: text.optional(),
  resolver: z.strictObject({ class: z.literal(BY_REC_RESOLVER.class), id: z.literal(BY_REC_RESOLVER.id) }),
  overrule: overruleSchema.optional(),
});

export const byRecRowSchema = rowFields.refine((row) => (row.result === "overruled") === (row.overrule !== undefined), {
  message: "an overruled row, and only that row, carries overrule",
  path: ["overrule"],
});

export type ByRecPolicy = z.infer<typeof byRecPolicySchema>;
export type ByRecPolicyInput = z.input<typeof byRecPolicySchema>;
export type ByRecExclusion = z.infer<typeof exclusionSchema>;
export type ByRecRow = z.infer<typeof byRecRowSchema>;
export type ByRecSource = (typeof BY_REC_SOURCES)[number];
