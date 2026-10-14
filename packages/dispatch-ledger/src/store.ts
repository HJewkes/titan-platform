import { illegalEdgeError } from "./claim-phase.js";
import { LedgerMalformedError, isLedger, parseLedgerJson } from "./json.js";
import { EMPTY_LEDGER, LedgerSchema, type Claim, type Ledger } from "./schema.js";

export interface LedgerRead {
  ledger: Ledger;
  /** Bumped by every write; 0 before the first. */
  revision: number;
}

/** Where the ledger lives. A write checks the revision it read and the phase edges, and commits whole or not at all. */
export interface LedgerStore {
  read(): LedgerRead;
  /** Throws `StaleRevisionError`, `IllegalPhaseEdgeError` or `LedgerMalformedError`, leaving the store unchanged. */
  write(next: Ledger, expectedRevision?: number): { revision: number };
}

/** A write whose `expectedRevision` another writer has moved past; the caller re-reads and retries. */
export class StaleRevisionError extends Error {
  override name = "StaleRevisionError";
}

/**
 * zod's output, laid out in `raw`'s key order with keys zod added at the end: keys the schema does not name are
 * dropped and contract scopes trimmed as agent-chat's read does, while a ledger already in that form keeps its bytes.
 */
export function normalizeLedger(raw: unknown): Ledger {
  const parsed = LedgerSchema.safeParse(raw);
  if (!parsed.success) throw new LedgerMalformedError("burndown ledger does not match the schema");
  const ordered = inRawOrder(raw, parsed.data);
  if (!isLedger(ordered)) throw new LedgerMalformedError("burndown ledger does not match the schema");
  return ordered;
}

type Plain = Record<string, unknown>;

export const isPlain = (value: unknown): value is Plain =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function inRawOrder(raw: unknown, parsed: unknown): unknown {
  if (Array.isArray(parsed)) return parsed.map((item, i) => inRawOrder(Array.isArray(raw) ? raw[i] : undefined, item));
  if (!isPlain(parsed)) return parsed;
  const source = isPlain(raw) ? raw : {};
  const keys = [
    ...Object.keys(source).filter((key) => Object.hasOwn(parsed, key)),
    ...Object.keys(parsed).filter((key) => !Object.hasOwn(source, key)),
  ];
  return Object.fromEntries(keys.map((key) => [key, inRawOrder(source[key], parsed[key])]));
}

/** Throws what a write from `current` to `next` must refuse, before anything is changed. */
export function assertWritable(
  current: { claims: readonly Claim[]; revision: number },
  next: Ledger,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision !== undefined && expectedRevision !== current.revision) {
    throw new StaleRevisionError(`ledger is at revision ${current.revision}, not ${expectedRevision}`);
  }
  const illegal = illegalEdgeError(current.claims, next.claims);
  if (illegal !== undefined) throw illegal;
}

/** Validates `text` as `burndown.json` and writes it to `store`, normalized. */
export function importLedgerJson(store: LedgerStore, text: string, expectedRevision?: number): { revision: number } {
  return store.write(parseLedgerJson(text), expectedRevision);
}

/** An in-process store for tests and dry runs; it hands out copies, so a caller's edits never reach it unwritten. */
export function memoryLedgerStore(initial: Ledger = EMPTY_LEDGER): LedgerStore {
  let ledger = normalizeLedger(initial);
  let revision = 0;
  return {
    read: () => ({ ledger: structuredClone(ledger), revision }),
    write(next, expectedRevision) {
      const normalized = normalizeLedger(next);
      assertWritable({ claims: ledger.claims, revision }, normalized, expectedRevision);
      ledger = structuredClone(normalized);
      revision += 1;
      return { revision };
    },
  };
}
