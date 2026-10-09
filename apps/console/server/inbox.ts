/**
 * The owner inbox's write path for agents: `inbox.deposit` files one OwnerItem deposit into the
 * spool, and `fileDeposit` is the `titan-console inbox file` client for it.
 *
 * A deposit cannot answer, resolve or route anything: the strict schema refuses every system
 * field, and this module never writes an answer file. That is why the deposit class runs on
 * unauthenticated loopback. `asker` comes from the body and is self-declared; nothing on
 * loopback names the caller, so the per-asker cap limits a runaway agent, not a hostile one.
 */
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { CLIENT_HEADER } from "@titan-design/daemon";
import { depositItemId, ownerItemDepositSchema, type OwnerItemDeposit } from "@titan-design/owner-queue";
import { MAX_DEPOSIT_BYTES, answerFileName, depositFileName, writeDeposit } from "@titan-design/owner-queue/spool";
import { EXIT } from "@titan-design/registry";
import { depositCommand } from "./owner-guard.js";

export const MAX_OPEN_DEPOSITS_PER_ASKER = 200;
export const INBOX_DEPOSIT = "inbox.deposit";

const DEPOSIT_SUFFIX = ".json";
const ANSWER_SUFFIX = ".answer.json";

export interface InboxSource {
  /** The spool directory; the daemon creates it 0700 on the first deposit. */
  dir: string;
}

class DepositRefusedError extends Error {
  constructor(
    message: string,
    readonly code: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DepositRefusedError";
  }
}

/** A filesystem error names the spool's path, which a LAN caller has no business learning. */
function withoutSpoolPath(error: unknown): never {
  if (error instanceof DepositRefusedError) throw error;
  throw new DepositRefusedError("the inbox spool could not be written", EXIT.SOFTWARE, { cause: error });
}

const depositResult = z.object({ id: z.string(), created: z.boolean() });
type DepositResult = z.infer<typeof depositResult>;

async function spoolNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** An undecodable name counts as open, so a strange depositId can only tighten its asker's cap. */
function isAnswered(present: ReadonlySet<string>, asker: string, encodedDepositId: string): boolean {
  try {
    return present.has(answerFileName(depositItemId(asker, decodeURIComponent(encodedDepositId))));
  } catch {
    return false;
  }
}

/**
 * Deposits by this asker with no answer beside them. Each name part is percent-encoded with "-"
 * escaped, so `<asker>-` is a prefix of this asker's deposit files and of no other asker's.
 */
function openDepositCount(names: readonly string[], asker: string): number {
  const prefix = depositFileName(asker, "").slice(0, -DEPOSIT_SUFFIX.length);
  const present = new Set(names);
  return names.filter(
    (name) =>
      name.startsWith(prefix) &&
      name.endsWith(DEPOSIT_SUFFIX) &&
      !name.endsWith(ANSWER_SUFFIX) &&
      !isAnswered(present, asker, name.slice(prefix.length, -DEPOSIT_SUFFIX.length)),
  ).length;
}

/** Size and name checks first, so an oversized or unnameable deposit is the caller's 400, never a 500. */
function fileNameFor(deposit: OwnerItemDeposit): string {
  if (Buffer.byteLength(JSON.stringify(deposit)) > MAX_DEPOSIT_BYTES) {
    throw new DepositRefusedError(`deposit exceeds ${MAX_DEPOSIT_BYTES} bytes`, EXIT.DATAERR);
  }
  try {
    return depositFileName(deposit.asker, deposit.depositId);
  } catch {
    throw new DepositRefusedError("asker and depositId are too long to name a spool file", EXIT.DATAERR);
  }
}

/** A repeat of a filed depositId returns its id even at the cap, since it adds nothing to the spool. */
async function fileOnce(dir: string, deposit: OwnerItemDeposit): Promise<DepositResult> {
  const name = fileNameFor(deposit);
  const id = depositItemId(deposit.asker, deposit.depositId);
  const names = await spoolNames(dir);
  if (names.includes(name)) return { id, created: false };
  if (openDepositCount(names, deposit.asker) >= MAX_OPEN_DEPOSITS_PER_ASKER) {
    throw new DepositRefusedError(`this asker already has ${MAX_OPEN_DEPOSITS_PER_ASKER} open deposits`, EXIT.TEMPFAIL);
  }
  const { created } = await writeDeposit(dir, deposit);
  return { id, created };
}

/** One deposit at a time, so two racing deposits cannot both pass the cap. */
function serializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export function inboxCommands({ dir }: InboxSource) {
  const serialize = serializer();
  return {
    [INBOX_DEPOSIT]: depositCommand({
      name: INBOX_DEPOSIT,
      description: "File one owner item into the owner inbox; a repeat depositId returns the item id it already has",
      args: ownerItemDepositSchema,
      result: depositResult,
      run: (deposit: OwnerItemDeposit) => serialize(() => fileOnce(dir, deposit).catch(withoutSpoolPath)),
    }),
  };
}

/**
 * Posts a deposit body to the console on this machine and returns the item id. The address is
 * always 127.0.0.1, and a redirect is refused, so the body never leaves loopback.
 */
export async function fileDeposit(port: number, body: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (port === 0) throw new Error("TITAN_CONSOLE_PORT is 0, so there is no console port to file to");
  const origin = `http://127.0.0.1:${port}`;
  const response = await fetchImpl(`${origin}/rpc/${INBOX_DEPOSIT}`, {
    method: "POST",
    headers: { "content-type": "application/json", [CLIENT_HEADER]: "titan-console inbox file" },
    body,
    redirect: "error",
  }).catch(() => {
    throw new Error(`no console answered at ${origin}; start it with \`titan-console\` or set TITAN_CONSOLE_PORT`);
  });
  const envelope = (await response.json().catch(() => null)) as { ok?: boolean; data?: DepositResult; error?: string } | null;
  if (envelope?.ok === true && envelope.data) return envelope.data.id;
  throw new Error(`inbox.deposit refused (HTTP ${response.status}): ${envelope?.error ?? "no envelope in the reply"}`);
}
