import fs from "node:fs";
import path from "node:path";
import { LedgerSchema, type Ledger } from "./schema.js";

/** Named so a recorded failure says what failed without carrying a file path in the message. */
export class LedgerMalformedError extends Error {
  override name = "LedgerMalformedError";
}

/**
 * Validates `text` as a `burndown.json` ledger and returns the raw parsed JSON, not zod's output: zod emits keys in
 * shape order and drops unknown ones, so only the raw value exports back to the same bytes. A malformed ledger throws,
 * because guessing would double-dispatch.
 */
export function parseLedgerJson(text: string): Ledger {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LedgerMalformedError("burndown ledger is not JSON");
  }
  if (!isLedger(raw)) throw new LedgerMalformedError("burndown ledger does not match the schema");
  return raw;
}

export const isLedger = (raw: unknown): raw is Ledger => LedgerSchema.safeParse(raw).success;

/** The `burndown.json` bytes for `ledger`. */
export const exportLedgerJson = (ledger: Ledger): string => `${JSON.stringify(ledger, null, 2)}\n`;

/**
 * Write-then-rename in the same directory, so a reader never sees half a ledger. The export is read-only, so it
 * checks no phase edges; the store's write does.
 */
export function writeLedgerExport(file: string, ledger: Ledger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, exportLedgerJson(ledger), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
