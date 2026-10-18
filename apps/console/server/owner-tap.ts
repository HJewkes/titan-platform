/**
 * The owner-tap kernel every two-step console tap shares, whatever it targets. `prepare` remembers the confirm digest it
 * issued for five minutes in a `preparedStore`; `act` looks it up under the same target key, writes the action record once
 * (O_EXCL, 0600, in a 0700 directory) as `<actionsDir>/<confirm>.json`, reads it back, dispatches it, and writes the settled
 * outcome once beside it as `<confirm>.outcome.json`. A replay finds the record already there and dispatches the same bytes.
 *
 * What a tap reads back, how it dispatches, and what it logs afterwards stay with the tap (`inbox-actions.ts`).
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";

export const CONFIRM_TTL_MS = 5 * 60_000;
export const MAX_PREPARED = 256;
export const CONFIRM = /^[0-9a-f]{64}$/;

export interface Prepared {
  /** What the confirm was issued for: an inbox item id, or a tap's serialised target. */
  key: string;
  readAt: string;
  expiresAt: number;
}

export const refuse = (message: string): never => {
  throw failure(message, EXIT.DATAERR);
};

/** Whatever the parts hold is bound by the digest, so a tap puts its read-back in them to refuse a stale confirm. */
export const digestOf = (parts: readonly unknown[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** Confirms this console issued, newest last; expired ones are dropped on each remember, and the oldest past the cap. */
export function preparedStore(now: () => number) {
  const issued = new Map<string, Prepared>();
  return {
    remember(confirm: string, entry: Prepared): void {
      for (const [key, value] of issued) if (value.expiresAt <= now()) issued.delete(key);
      issued.set(confirm, entry);
      if (issued.size > MAX_PREPARED) issued.delete(issued.keys().next().value!);
    },
    lookup(confirm: string, key: string): Prepared | undefined {
      const entry = issued.get(confirm);
      return entry !== undefined && entry.key === key && entry.expiresAt > now() ? entry : undefined;
    },
  };
}

export type PreparedStore = ReturnType<typeof preparedStore>;

const errnoOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

/** False when the file already exists. A failed write removes the file it created, so it cannot block a retry. */
export async function writeOnce(file: string, bytes: string): Promise<boolean> {
  const handle = await open(file, "wx", 0o600).catch((error: unknown) => (errnoOf(error) === "EEXIST" ? null : Promise.reject(error)));
  if (handle === null) return false;
  try {
    await handle.writeFile(bytes);
  } catch (error) {
    await handle.close();
    await rm(file, { force: true });
    throw error;
  }
  await handle.close();
  return true;
}

const recordFileOf = (actionsDir: string, confirm: string): string => path.join(actionsDir, `${confirm}.json`);

export const outcomeFile = (file: string): string => file.replace(/\.json$/, ".outcome.json");

/** The directory is created 0700 so only this account reads what the owner confirmed. */
export async function writeRecord(actionsDir: string, file: string, record: object): Promise<void> {
  await mkdir(actionsDir, { recursive: true, mode: 0o700 });
  await writeOnce(file, `${JSON.stringify(record, null, 2)}\n`);
}

async function readRecord<T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const text = await readFile(file, "utf8").catch((error: unknown) => (errnoOf(error) === "ENOENT" ? undefined : Promise.reject(error)));
  return text === undefined ? undefined : schema.parse(JSON.parse(text));
}

interface RecordOnce<T> {
  store: PreparedStore;
  actionsDir: string;
  confirm: string;
  key: string;
  /** The refusal for a confirm this console never issued for `key`, or issued over five minutes ago. */
  stale: string;
  schema: z.ZodType<T>;
  /** Called only when no record exists yet: re-read the live target, re-check the digest, and write the record. */
  write: (file: string, prepared: Prepared) => Promise<void>;
}

/** The record a tap dispatches: the one already on disk on a replay, else the one `write` puts there now. */
export async function recordOnce<T>(spec: RecordOnce<T>): Promise<{ file: string; record: T }> {
  const prepared = spec.store.lookup(spec.confirm, spec.key) ?? refuse(spec.stale);
  const file = recordFileOf(spec.actionsDir, spec.confirm);
  if ((await readRecord(file, spec.schema)) === undefined) await spec.write(file, prepared);
  const record = (await readRecord(file, spec.schema)) ?? refuse("the action record could not be read back");
  return { file, record };
}

/** Neither status is a settled answer: the tap may be retried with the same confirm, so nothing is written. */
const TRANSIENT = new Set(["unreachable", "off"]);

/** True only for the call that wrote the outcome, so whatever follows a landed tap happens once. */
export async function settleOutcome(file: string, outcome: { status: string }, at: string): Promise<boolean> {
  if (TRANSIENT.has(outcome.status)) return false;
  return writeOnce(outcomeFile(file), `${JSON.stringify({ ...outcome, at })}\n`);
}

const settledOutcome = z.looseObject({ status: z.string(), runId: z.string().optional() });

type SettledOutcome = z.infer<typeof settledOutcome>;

export async function readSettled(file: string): Promise<SettledOutcome | undefined> {
  const text = await readFile(outcomeFile(file), "utf8").catch(() => undefined);
  return text === undefined ? undefined : settledOutcome.safeParse(JSON.parse(text)).data;
}
