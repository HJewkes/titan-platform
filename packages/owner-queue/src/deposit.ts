import { createHash } from "node:crypto";
import { z } from "zod";
import { addAnchorIssues } from "./deposit-anchors.js";
import { opKeys } from "./op.js";
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
  class: item.class,
  irreversible: item.irreversible,
  shown: item.shown,
  default: item.default,
  onSilence: item.onSilence,
  summary: item.summary,
  context: item.context,
  options: z.array(z.strictObject(option.shape)).min(2).max(8).optional(),
  recommended: z.strictObject(recommendation.omit({ hidden: true }).shape).optional(),
  command: item.command,
  op: item.op,
  evidenceRef: item.evidenceRef,
  anchors: item.anchors,
  pins: item.pins,
  keys: item.keys.default([]),
  seat: item.seat,
  initiative: item.initiative,
  personal: item.personal.default(false),
  unblocks: item.unblocks.default([]),
  unblocksNow: item.unblocksNow,
  blocker: item.blocker,
  audience: item.audience,
  expiresAt: item.expiresAt,
}).superRefine(addAnchorIssues).superRefine(addBlockerIssues);

function addBlockerIssues(deposit: { kind: (typeof ITEM_KINDS)[number]; blocker?: unknown }, ctx: z.RefinementCtx): void {
  if (deposit.blocker !== undefined && DEPOSIT_LENS[deposit.kind] !== "blocking-agent") {
    ctx.addIssue({ code: "custom", path: ["blocker"], message: "a blocker must be a decide, approve or do deposit" });
  }
}

const BLOCKER_SKEW_MS = 5 * 60_000;
const BLOCKER_MAX_AGE_MS = 30 * 24 * 3_600_000;

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

function assertBlockerSince(since: string, now: Date): void {
  const age = now.getTime() - new Date(since).getTime();
  if (age < -BLOCKER_SKEW_MS) throw new Error("blocker.since is in the future");
  if (age > BLOCKER_MAX_AGE_MS) throw new Error("blocker.since is more than 30 days old");
}

/**
 * Parses an untrusted deposit and returns the open OwnerItem it files; throws on a refused deposit.
 * An `op` adds the keys it implies, so a deposit about a PR joins that PR's item at the same head.
 */
export function fromDeposit(deposit: OwnerItemDeposit, now: Date): OwnerItem {
  const { depositId, ...fields } = ownerItemDepositSchema.parse(deposit);
  if (fields.blocker !== undefined) assertBlockerSince(fields.blocker.since, now);
  const implied = fields.op === undefined ? [] : opKeys(fields.op).filter((key) => !fields.keys.includes(key));
  return {
    ...fields,
    keys: [...fields.keys, ...implied],
    ...(fields.blocker !== undefined && { unblocksNow: fields.unblocksNow ?? fields.blocker.blocks.slice(0, 200) }),
    id: depositItemId(fields.asker, depositId),
    sources: [{ system: "deposit", ref: `${fields.asker}/${depositId}` }],
    lens: DEPOSIT_LENS[fields.kind],
    openedAt: now.toISOString(),
    status: "open",
  };
}
