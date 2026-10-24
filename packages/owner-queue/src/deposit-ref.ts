/**
 * Resolves what a person types for a deposit id. Deposit ids are `deposit:<32 hex>`, which nobody
 * copies whole, so a short hex prefix names one too, bare or after `deposit:`. Eight hex digits
 * is the shortest prefix taken: shorter ones collide too easily to trust from memory.
 */
export const DEPOSIT_PREFIX = "deposit:";
const HEX_PREFIX = /^[0-9a-f]{8,32}$/;

export type DepositRef<T> = { kind: "found"; item: T } | { kind: "not-deposit" } | { kind: "ambiguous"; ids: string[] } | { kind: "unknown" };

/** The one item `ref` names: by exact id, or as the only deposit id its hex prefix starts. */
export function resolveDepositRef<T extends { id: string }>(items: readonly T[], ref: string): DepositRef<T> {
  const isDeposit = ref.startsWith(DEPOSIT_PREFIX);
  if (!isDeposit && ref.includes(":")) return { kind: "not-deposit" };
  const exact = items.find((item) => item.id === ref);
  if (exact !== undefined) return { kind: "found", item: exact };
  const hex = (isDeposit ? ref.slice(DEPOSIT_PREFIX.length) : ref).toLowerCase();
  if (!HEX_PREFIX.test(hex)) return { kind: "unknown" };
  const matches = items.filter((item) => item.id.startsWith(`${DEPOSIT_PREFIX}${hex}`));
  const [only] = matches;
  if (only !== undefined && matches.length === 1) return { kind: "found", item: only };
  return only === undefined ? { kind: "unknown" } : { kind: "ambiguous", ids: matches.map((item) => item.id).sort() };
}
