import { toJSONSchema, z } from "zod";
import { LedgerOptionSchema } from "./ledger.js";
import { policyCategory } from "./normalize.js";
import { checkUnlock } from "./unlock.js";

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
    input: toJSONSchema(DecideInputSchema),
    reply: toJSONSchema(DecideReplySchema),
  };
}

/** Rows match on `policyCategory`, so `Tech Design` reads `tech_design`; when several spellings match, the strictest threshold wins. */
export function minConfidenceFor(category: string, policy: DecidePolicy): number {
  const key = policyCategory(category);
  const matches = Object.entries(policy.categories ?? {}).flatMap(([name, row]) =>
    policyCategory(name) === key && row.minConfidence !== undefined ? [row.minConfidence] : []
  );
  return matches.length > 0 ? Math.max(...matches) : DEFAULT_MIN_CONFIDENCE;
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

/** A picked option is only trusted when the answer text says the same thing. */
function answerMatchErrors(reply: DecideReply, input: DecideInput): string[] {
  const option = reply.optionIndex === null ? undefined : input.options[reply.optionIndex];
  if (option === undefined || reply.answer.trim() === option.label.trim()) return [];
  return [`answer ${JSON.stringify(reply.answer)} does not match option ${reply.optionIndex} ${JSON.stringify(option.label)}`];
}

function forceEscalation(reply: DecideReply, reason: string): DecideReply {
  const escalateReason = reply.escalate && reply.escalateReason ? `${reply.escalateReason}; ${reason}` : reason;
  return { ...reply, escalate: true, escalateReason };
}

/** A reply under its category's threshold stands only as an escalation, with the reason recorded. */
function applyThreshold(reply: DecideReply, input: DecideInput, policy: DecidePolicy): DecideReply {
  const min = minConfidenceFor(input.category, policy);
  if (reply.confidence >= min) return reply;
  return forceEscalation(reply, `confidence ${reply.confidence} is under the ${input.category} threshold ${min}`);
}

/** An answer the unlock table claims stays with the owner, however confident the decider is. */
function applyUnlock(reply: DecideReply, input: DecideInput): DecideReply {
  const check = checkUnlock(input.question, reply.answer, input.category);
  return check.ok ? reply : forceEscalation(reply, check.reason);
}

/** Checks a raw reply against its input; a bad reply is a typed failure, never a throw. */
export function validate(reply: unknown, input: DecideInput, policy: DecidePolicy = {}): DecideValidation {
  const parsed = DecideReplySchema.safeParse(reply);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "reply"}: ${i.message}`) };
  }
  const errors = [
    ...citationErrors(parsed.data, input),
    ...optionIndexErrors(parsed.data, input),
    ...answerMatchErrors(parsed.data, input),
  ];
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, reply: applyUnlock(applyThreshold(parsed.data, input, policy), input) };
}
