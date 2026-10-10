import { createHash } from "node:crypto";
import { z } from "zod";
import { ownerItemSchema, type ITEM_KINDS, type LENSES, type OwnerItem } from "./schema.js";

const item = ownerItemSchema.shape;
const option = item.options.unwrap().element;
const recommendation = item.recommended.unwrap();

/**
 * What an agent may file into the owner inbox. Strict at every level, so a deposit that tries
 * to set a system field (id, status, answer, route, authority, lint, a hidden pick) is refused
 * rather than silently stripped.
 */
export const ownerItemDepositSchema = z.strictObject({
  depositId: z.string().min(1).max(128),
  asker: z.string().min(1),
  kind: item.kind,
  door: item.door,
  summary: item.summary,
  context: item.context,
  options: z.array(z.strictObject(option.shape)).min(2).max(8).optional(),
  recommended: z.strictObject(recommendation.omit({ hidden: true }).shape).optional(),
  command: item.command,
  evidenceRef: item.evidenceRef,
  keys: item.keys.default([]),
  seat: item.seat,
  initiative: item.initiative,
  personal: item.personal.default(false),
  unblocks: item.unblocks.default([]),
  expiresAt: item.expiresAt,
});

export type OwnerItemDeposit = z.input<typeof ownerItemDepositSchema>;

/** Every deposit has an asker waiting on it, so only Know items leave the blocking lens. */
export const DEPOSIT_LENS = {
  decide: "blocking-agent",
  approve: "blocking-agent",
  do: "blocking-agent",
  review: "planning",
  know: "fyi",
} as const satisfies Record<(typeof ITEM_KINDS)[number], (typeof LENSES)[number]>;

/** The JSON pair keeps the input injective, so an asker containing "/" cannot collide with another. */
export function depositItemId(asker: string, depositId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([asker, depositId])).digest("hex");
  return `deposit:${digest.slice(0, 32)}`;
}

/** Parses an untrusted deposit and returns the open OwnerItem it files; throws on a refused deposit. */
export function fromDeposit(deposit: OwnerItemDeposit, now: Date): OwnerItem {
  const { depositId, ...fields } = ownerItemDepositSchema.parse(deposit);
  return {
    ...fields,
    id: depositItemId(fields.asker, depositId),
    sources: [{ system: "deposit", ref: `${fields.asker}/${depositId}` }],
    lens: DEPOSIT_LENS[fields.kind],
    openedAt: now.toISOString(),
    status: "open",
  };
}
