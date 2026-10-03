import { toJSONSchema, z } from "zod";
import { LedgerOptionSchema } from "./ledger.js";

/** The confidence a reply needs in a category with no policy row (plan 3.3). */
export const DEFAULT_MIN_CONFIDENCE = 0.8;

export const DecidePrincipleSchema = z.object({
  id: z.string().min(1),
  rule: z.string(),
  confidence: z.number().min(0).max(1),
  /** Ledger keys of the owner answers behind the rule. */
  examples: z.array(z.string()),
});

export const DecidePrecedentSchema = z.object({
  key: z.string().min(1),
  quote: z.string(),
});

/** What the decider is shown: one question plus the principles and precedents it may cite. */
export const DecideInputSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(LedgerOptionSchema),
  recommended: z.string().nullable(),
  category: z.string().min(1),
  initiative: z.string().nullable(),
  context: z.string(),
  principles: z.array(DecidePrincipleSchema),
  precedents: z.array(DecidePrecedentSchema),
});

/** What the decider answers; `validate` decides whether it may stand. */
export const DecideReplySchema = z.object({
  answer: z.string(),
  optionIndex: z.number().int().nullable(),
  confidence: z.number().min(0).max(1),
  principleIds: z.array(z.string()),
  escalate: z.boolean(),
  escalateReason: z.string().optional(),
  /** How the answer could be undone, in the decider's words. */
  reversible: z.string(),
});

export type DecidePrinciple = z.infer<typeof DecidePrincipleSchema>;
export type DecidePrecedent = z.infer<typeof DecidePrecedentSchema>;
export type DecideInput = z.infer<typeof DecideInputSchema>;
export type DecideReply = z.infer<typeof DecideReplySchema>;

/** The threshold slice of a category's policy row; fuller rows from the router are assignable. */
export interface CategoryThreshold {
  minConfidence?: number;
}

export interface DecidePolicy {
  categories?: Readonly<Record<string, CategoryThreshold>>;
}

export type DecideValidation = { ok: true; reply: DecideReply } | { ok: false; errors: string[] };

/** JSON Schema for both halves of the contract, for model prompts and non-TypeScript callers. */
export function decideJsonSchemas(): { input: Record<string, unknown>; reply: Record<string, unknown> } {
  return {
    input: toJSONSchema(DecideInputSchema) as Record<string, unknown>,
    reply: toJSONSchema(DecideReplySchema) as Record<string, unknown>,
  };
}

export function minConfidenceFor(category: string, policy: DecidePolicy): number {
  return policy.categories?.[category]?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
}

function citationErrors(reply: DecideReply, input: DecideInput): string[] {
  const known = new Set(input.principles.map((p) => p.id));
  const unknown = [...new Set(reply.principleIds.filter((id) => !known.has(id)))];
  return unknown.map((id) => `principleIds cites ${JSON.stringify(id)}, which is not in the input`);
}

function optionIndexErrors(reply: DecideReply, input: DecideInput): string[] {
  const index = reply.optionIndex;
  if (index === null || (index >= 0 && index < input.options.length)) return [];
  return [`optionIndex ${index} is outside the ${input.options.length} input options`];
}

/** A reply under its category's threshold stands only as an escalation, with the reason recorded. */
function applyThreshold(reply: DecideReply, input: DecideInput, policy: DecidePolicy): DecideReply {
  const min = minConfidenceFor(input.category, policy);
  if (reply.confidence >= min) return reply;
  const reason = `confidence ${reply.confidence} is under the ${input.category} threshold ${min}`;
  const escalateReason = reply.escalate && reply.escalateReason ? `${reply.escalateReason}; ${reason}` : reason;
  return { ...reply, escalate: true, escalateReason };
}

/** Checks a raw reply against its input; a bad reply is a typed failure, never a throw. */
export function validate(reply: unknown, input: DecideInput, policy: DecidePolicy = {}): DecideValidation {
  const parsed = DecideReplySchema.safeParse(reply);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "reply"}: ${i.message}`) };
  }
  const errors = [...citationErrors(parsed.data, input), ...optionIndexErrors(parsed.data, input)];
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, reply: applyThreshold(parsed.data, input, policy) };
}
