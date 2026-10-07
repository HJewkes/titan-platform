import { z } from "zod";

export const SOURCE_SYSTEMS = ["agent-chat", "hitl", "morning", "active-work", "round", "plan"] as const;
export const ITEM_KINDS = ["decide", "approve", "do", "review", "know"] as const;
export const DOORS = ["one-way", "two-way"] as const;
export const LENSES = ["blocking-agent", "blocking-merge", "stuck", "planning", "fyi"] as const;
export const ROUTE_TARGETS = ["owner-now", "owner-queue", "decider"] as const;
export const ITEM_STATUSES = ["open", "answered", "decided", "expired", "gone-elsewhere", "withdrawn"] as const;

const timestamp = z.iso.datetime({ offset: true });

export const sourceRefSchema = z.object({
  system: z.enum(SOURCE_SYSTEMS),
  ref: z.string().min(1),
});

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

const recommendationSchema = z.object({
  optionId: z.string().min(1),
  by: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
  cite: z.string().optional(),
  hidden: z.boolean().optional(),
});

const answerSchema = z.object({
  optionId: z.string().min(1).optional(),
  text: z.string().optional(),
  by: z.object({ class: z.string().min(1), id: z.string().min(1), channel: z.string().min(1) }),
  at: timestamp,
  covers: z.number().int().positive().optional(),
});

export const ownerItemSchema = z.object({
  id: z.string().min(1),
  sources: z.array(sourceRefSchema).min(1),
  kind: z.enum(ITEM_KINDS),
  door: z.enum(DOORS),
  category: z.string().min(1).optional(),
  summary: z.string().min(1).max(280).regex(/^[^\n]*$/, "summary is one line"),
  context: z.string(),
  options: z.array(optionSchema).min(2).max(8).optional(),
  recommended: recommendationSchema.optional(),
  command: z.string().min(1).optional(),
  evidenceRef: z.string().min(1).optional(),
  keys: z.array(z.string().min(1)),
  asker: z.string().optional(),
  seat: z.string().optional(),
  initiative: z.string().optional(),
  personal: z.boolean(),
  lens: z.enum(LENSES),
  stuckKind: z.string().optional(),
  unblocks: z.array(z.string().min(1)),
  route: z.object({ target: z.enum(ROUTE_TARGETS), reason: z.string(), shadow: z.boolean() }).optional(),
  authority: z.object({ table: z.string(), ruleId: z.string(), resolvers: z.array(z.string()) }).optional(),
  openedAt: timestamp,
  expiresAt: timestamp.optional(),
  status: z.enum(ITEM_STATUSES),
  answer: answerSchema.optional(),
  lint: z.array(z.string()).optional(),
});

export type SourceRef = z.infer<typeof sourceRefSchema>;
export type OwnerItem = z.infer<typeof ownerItemSchema>;
export type OwnerAnswer = z.infer<typeof answerSchema>;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
