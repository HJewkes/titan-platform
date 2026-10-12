import { ownerItemSchema, type OwnerItem } from "./schema.js";

export const CARD_RULES = [
  "card:options",
  "card:consequence",
  "card:class",
  "card:on-silence",
  "card:default-not-option",
  "card:apply-default-needs-default",
  "card:one-way-irreversible",
  "card:one-way-waits",
] as const;
export type CardRule = (typeof CARD_RULES)[number];

/** Only these kinds ask the owner to choose, so only they must carry a full card. */
const DECISION_KINDS: ReadonlySet<OwnerItem["kind"]> = new Set(["decide", "approve"]);

type CardChecks = Record<CardRule, boolean>;

function decisionChecks(item: OwnerItem): Pick<CardChecks, "card:options" | "card:class" | "card:on-silence" | "card:one-way-irreversible"> {
  return {
    "card:options": (item.options?.length ?? 0) < 2,
    "card:class": item.class === undefined,
    "card:on-silence": item.onSilence === undefined,
    "card:one-way-irreversible": item.door === "one-way" && item.irreversible === undefined,
  };
}

/** Rules that fire on any kind, but only on a field the item set. */
function setFieldChecks(item: OwnerItem): Pick<CardChecks, "card:consequence" | "card:default-not-option" | "card:apply-default-needs-default" | "card:one-way-waits"> {
  const optionIds = new Set((item.options ?? []).map((option) => option.id));
  return {
    "card:consequence": (item.options ?? []).some((option) => option.consequence === undefined),
    "card:default-not-option": item.default !== undefined && !optionIds.has(item.default),
    "card:apply-default-needs-default": item.onSilence?.action === "apply-default" && item.default === undefined,
    "card:one-way-waits": item.door === "one-way" && item.onSilence !== undefined && item.onSilence.action !== "wait",
  };
}

/**
 * The card rules an item breaks, in `CARD_RULES` order. A one-way decision must say what it
 * cannot undo and must wait on silence, because nothing irreversible may happen by default.
 */
export function cardLint(item: OwnerItem): CardRule[] {
  const decision = DECISION_KINDS.has(item.kind) ? decisionChecks(item) : {};
  const checks: Partial<CardChecks> = { ...decision, ...setFieldChecks(item) };
  return CARD_RULES.filter((rule) => checks[rule]);
}

/** An OwnerItem that also passes every card rule; each broken rule is one issue named by its id. */
export const ownerCardSchema = ownerItemSchema.superRefine((item, ctx) => {
  for (const rule of cardLint(item)) ctx.addIssue({ code: "custom", message: rule });
});
