import { z } from "zod";

export const SOURCE_SYSTEMS = ["agent-chat", "hitl", "morning", "active-work", "round", "plan", "deposit"] as const;
export const ITEM_KINDS = ["decide", "approve", "do", "review", "know"] as const;
export const DOORS = ["one-way", "two-way"] as const;
export const LENSES = ["blocking-agent", "blocking-merge", "stuck", "planning", "fyi"] as const;
export const ROUTE_TARGETS = ["owner-now", "owner-queue", "decider"] as const;
export const AUDIENCES = ["owner", "operator"] as const;
export const ITEM_STATUSES = ["open", "answered", "decided", "expired", "gone-elsewhere", "withdrawn"] as const;
export const ON_SILENCE_ACTIONS = ["wait", "apply-default", "expire"] as const;

const timestamp = z.iso.datetime({ offset: true });
const oneLine = z.string().min(1).max(280).regex(/^[^\n]*$/, "one line");
/** The evidenceRef convention: an https URL, an absolute path, or a `$ <command>` to re-run. */
const shownRef = z.string().regex(/^(https:\/\/\S+|\/[^\n]*|\$ [^\n]+)$/, "an https URL, an absolute path or `$ <command>`");

const commitSha = z.string().regex(/^[0-9a-f]{40}$/, "a 40-hex commit id");
/** A code anchor such as `head/src/a.ts#L10-L20`, resolved against the item's `pins`. */
const anchorsSchema = z.array(z.string().min(1).max(500).regex(/^(head|base|diff)\//, "an anchor: head/, base/ or diff/<path>#L<n>")).min(1).max(8);
const pinsSchema = z.strictObject({ repo: z.string().min(1), head: commitSha, base: commitSha.optional() });

const onSilenceSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("wait") }),
  z.strictObject({ action: z.enum(["apply-default", "expire"]), afterHours: z.number().int().min(1).max(720) }),
]);

export const sourceRefSchema = z.object({
  system: z.enum(SOURCE_SYSTEMS),
  ref: z.string().min(1),
});

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  /** What picking this option sets in motion, so the owner sees the cost before choosing. */
  consequence: oneLine.optional(),
  anchors: anchorsSchema.optional(),
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
  /** A pick-many answer's offered options, in the order picked. */
  optionIds: z.array(z.string().min(1)).min(1).optional(),
  text: z.string().optional(),
  /** The owner asked for changes rather than choosing; an open change request blocks a ship. */
  changeRequested: z.literal(true).optional(),
  variantComments: z.array(z.object({ key: z.string().min(1), comment: z.string().min(1) })).min(1).optional(),
  by: z.object({ class: z.string().min(1), id: z.string().min(1), channel: z.string().min(1) }),
  at: timestamp,
  covers: z.number().int().positive().optional(),
});

export const ownerItemSchema = z.object({
  id: z.string().min(1),
  sources: z.array(sourceRefSchema).min(1),
  kind: z.enum(ITEM_KINDS),
  door: z.enum(DOORS),
  /** The decision-routing table row (D-row) this decision belongs to. */
  class: z.string().regex(/^D\d{1,3}$/).optional(),
  /** What cannot be undone once answered; a one-way card needs it. */
  irreversible: oneLine.optional(),
  shown: z.array(shownRef).min(1).max(8).optional(),
  /** The option id taken when nobody answers and onSilence says apply-default. */
  default: z.string().min(1).optional(),
  onSilence: onSilenceSchema.optional(),
  category: z.string().min(1).optional(),
  summary: z.string().min(1).max(280).regex(/^[^\n]*$/, "summary is one line"),
  context: z.string(),
  options: z.array(optionSchema).min(2).max(8).optional(),
  recommended: recommendationSchema.optional(),
  command: z.string().min(1).optional(),
  evidenceRef: z.string().min(1).optional(),
  anchors: anchorsSchema.optional(),
  /** The commits every anchor on the item and its options resolves against. */
  pins: pinsSchema.optional(),
  keys: z.array(z.string().min(1)),
  asker: z.string().optional(),
  seat: z.string().optional(),
  initiative: z.string().optional(),
  personal: z.boolean(),
  lens: z.enum(LENSES),
  stuckKind: z.string().optional(),
  unblocks: z.array(z.string().min(1)),
  /** Which reader the item is for; absent means the owner. Selects a view, grants no authority. */
  audience: z.enum(AUDIENCES).optional(),
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
export type Audience = (typeof AUDIENCES)[number];
export type OnSilence = z.infer<typeof onSilenceSchema>;
