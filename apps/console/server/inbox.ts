/**
 * The owner inbox's write path for agents: `inbox.deposit` files one OwnerItem deposit into the
 * spool, and `fileDeposit` is the `titan-console inbox file` client for it.
 *
 * A deposit cannot answer, resolve or route anything: the strict schema refuses every system
 * field, and this module never writes an answer file. That is why the deposit class runs on
 * unauthenticated loopback. `asker` comes from the body and is self-declared; nothing on
 * loopback names the caller, so the per-asker cap limits a runaway agent, not a hostile one.
 * The spool-wide cap is what bounds a caller that invents a new asker for every deposit.
 */
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { CLIENT_HEADER } from "@titan-design/daemon";
import { depositItemId, ownerItemDepositSchema, type OwnerItemDeposit } from "@titan-design/owner-queue";
import {
  MAX_DEPOSIT_BYTES,
  SpoolNameCollisionError,
  answerFileNames,
  depositFileName,
  depositFileNames,
  writeDeposit,
} from "@titan-design/owner-queue/spool";
import { EXIT } from "@titan-design/registry";
import { depositCommand } from "./owner-guard.js";

export const MAX_OPEN_DEPOSITS_PER_ASKER = 200;
export const MAX_OPEN_DEPOSITS = 2000;
export const INBOX_DEPOSIT = "inbox.deposit";

/**
 * The `/rpc` body cap for `inbox.deposit`, checked before the body is buffered. Three times the
 * stored cap, because a client that writes non-ASCII as `\uXXXX` escapes (Python's default) sends
 * six bytes for each two-byte character (U+0080-07FF) and twelve for each four-byte astral one;
 * the stored cap is still checked after parsing.
 */
export const INBOX_DEPOSIT_BODY_LIMIT = 3 * MAX_DEPOSIT_BYTES;

const DEPOSIT_SUFFIX = ".json";
const ANSWER_SUFFIX = ".answer.json";

export interface InboxSource {
  /** The spool directory; the daemon creates it 0700 on the first deposit. */
  dir: string;
  /** Open deposits across every asker before a new one gets 429; defaults to {@link MAX_OPEN_DEPOSITS}. */
  maxOpenDeposits?: number;
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
  if (error instanceof SpoolNameCollisionError) {
    throw new DepositRefusedError("this depositId's spool file is held by a different deposit; file under another depositId", EXIT.DATAERR);
  }
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

function decodedPart(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

interface FiledDeposit {
  /** Undefined when the name does not decode; such a file still counts against the spool-wide cap. */
  asker: string | undefined;
  depositId: string | undefined;
}

/** "-" is escaped inside each encoded part, so the first "-" in a deposit name is the separator. */
function parseDepositName(name: string): FiledDeposit {
  const stem = name.slice(0, -DEPOSIT_SUFFIX.length);
  const separator = stem.indexOf("-");
  if (separator < 0) return { asker: undefined, depositId: undefined };
  return { asker: decodedPart(stem.slice(0, separator)), depositId: decodedPart(stem.slice(separator + 1)) };
}

/** An undecodable name counts as open, so a strange file can only tighten a cap. */
function isAnswered(present: ReadonlySet<string>, { asker, depositId }: FiledDeposit): boolean {
  if (asker === undefined || depositId === undefined) return false;
  try {
    return answerFileNames(depositItemId(asker, depositId)).some((name) => present.has(name));
  } catch {
    return false;
  }
}

/** The asker of every deposit file with no answer beside it, under either the current or the legacy name. */
function openDepositAskers(names: readonly string[]): (string | undefined)[] {
  const present = new Set(names);
  return names
    .filter((name) => !name.startsWith(".") && name.endsWith(DEPOSIT_SUFFIX) && !name.endsWith(ANSWER_SUFFIX))
    .map(parseDepositName)
    .filter((filed) => !isAnswered(present, filed))
    .map((filed) => filed.asker);
}

/** Size and name checks first, so an oversized or unnameable deposit is the caller's 400, never a 500. */
function assertNameable(deposit: OwnerItemDeposit): void {
  if (Buffer.byteLength(JSON.stringify(deposit)) > MAX_DEPOSIT_BYTES) {
    throw new DepositRefusedError(`deposit exceeds ${MAX_DEPOSIT_BYTES} bytes`, EXIT.DATAERR);
  }
  try {
    depositFileName(deposit.asker, deposit.depositId);
  } catch (error) {
    throw new DepositRefusedError(`asker and depositId cannot name a spool file: ${(error as Error).message}`, EXIT.DATAERR);
  }
}

function assertUnderCaps(names: readonly string[], asker: string, maxOpenDeposits: number): void {
  const askers = openDepositAskers(names);
  if (askers.filter((each) => each === asker).length >= MAX_OPEN_DEPOSITS_PER_ASKER) {
    throw new DepositRefusedError(`this asker already has ${MAX_OPEN_DEPOSITS_PER_ASKER} open deposits`, EXIT.TEMPFAIL);
  }
  if (askers.length >= maxOpenDeposits) {
    throw new DepositRefusedError(`the inbox already has ${maxOpenDeposits} open deposits`, EXIT.TEMPFAIL);
  }
}

/**
 * A repeat of a filed depositId returns its id even at a cap, since it adds nothing to the spool.
 * The repeat still goes through writeDeposit, which proves the file under that name is this deposit.
 */
async function fileOnce(dir: string, deposit: OwnerItemDeposit, maxOpenDeposits: number): Promise<DepositResult> {
  assertNameable(deposit);
  const id = depositItemId(deposit.asker, deposit.depositId);
  const names = await spoolNames(dir);
  const isRepeat = depositFileNames(deposit.asker, deposit.depositId).some((name) => names.includes(name));
  if (!isRepeat) assertUnderCaps(names, deposit.asker, maxOpenDeposits);
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

export function inboxCommands({ dir, maxOpenDeposits = MAX_OPEN_DEPOSITS }: InboxSource) {
  const serialize = serializer();
  return {
    [INBOX_DEPOSIT]: depositCommand({
      name: INBOX_DEPOSIT,
      description: "File one owner item into the owner inbox; a repeat depositId returns the item id it already has",
      args: ownerItemDepositSchema,
      result: depositResult,
      run: (deposit: OwnerItemDeposit) => serialize(() => fileOnce(dir, deposit, maxOpenDeposits).catch(withoutSpoolPath)),
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
