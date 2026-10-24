import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OwnerOp } from "@titan-design/owner-queue";

export const OWNER_OPS_LEDGER = "owner-ops.jsonl";
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;

export type LedgerEntry =
  | { at: string; actionId: string; phase: "started"; kind: OwnerOp["kind"]; target: Record<string, unknown> }
  | { at: string; actionId: string; phase: "done"; result: object };

export interface OwnerOpsLedger {
  append(entry: LedgerEntry): Promise<void>;
  /** This action's lines, oldest first; none before the first append. */
  read(actionId: string): Promise<LedgerEntry[]>;
}

/** `<stateDir>/owner-ops.jsonl`, one JSON line per append; O_APPEND keeps each line whole when two ops write at once. */
export function ownerOpsLedger(stateDir: string): OwnerOpsLedger {
  const path = join(stateDir, OWNER_OPS_LEDGER);
  return {
    async append(entry) {
      const handle = await open(path, APPEND_FLAGS, 0o600);
      try {
        await handle.write(`${JSON.stringify(entry)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    async read(actionId) {
      const text = await readFile(path, { encoding: "utf8", flag: READ_FLAGS }).catch((error: unknown) => {
        if ((error as { code?: unknown }).code === "ENOENT") return "";
        throw error;
      });
      return text.split("\n").flatMap((line) => entryOf(line, actionId));
    },
  };
}

/** A torn last line from a crash mid-append is skipped, not fatal: the lines before it are whole. */
function entryOf(line: string, actionId: string): LedgerEntry[] {
  try {
    const entry = JSON.parse(line) as LedgerEntry;
    return entry.actionId === actionId ? [entry] : [];
  } catch {
    return [];
  }
}

interface LoggedOp {
  actionId: string;
  op: OwnerOp;
  now: () => number;
}

/**
 * `started` is durable before the effect runs, so an effect that crashes or throws leaves a `started` with no `done`: the
 * replay of that record sees an op that may have half-applied and re-reads the system of record instead of acting blind.
 */
export async function runLogged<R extends object>(ledger: OwnerOpsLedger, { actionId, op, now }: LoggedOp, effect: () => Promise<R>): Promise<R> {
  const { kind, ...target } = op;
  await ledger.append({ at: new Date(now()).toISOString(), actionId, phase: "started", kind, target });
  const result = await effect();
  await ledger.append({ at: new Date(now()).toISOString(), actionId, phase: "done", result });
  return result;
}
