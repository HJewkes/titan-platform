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
  DepositCiteError,
  MAX_DEPOSIT_BYTES,
  SpoolNameCollisionError,
  type SessionEventTextSource,
  answerFileNames,
  depositFileName,
  depositFileNames,
  withdrawnFileName,
  writeDeposit,
} from "@titan-design/owner-queue/spool";
import { EXIT } from "@titan-design/registry";
import { readSessionEventText } from "@titan-design/session-read";
import { depositCommand } from "./owner-guard.js";

/** TP-4353: a seat holds at most five open owner asks, so it merges or withdraws one before it files another. */
export const MAX_OPEN_DEPOSITS_PER_ASKER = 5;
/** The owner's own deposits are notes to self, never a seat's asks, so no per-asker cap applies to them. */
export const OWNER_ASKERS: ReadonlySet<string> = new Set(["hjewkes", "owner"]);
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
  /** Checks a recommendation's locator cite against its transcript line; defaults to session-read's Claude transcripts. */
  events?: SessionEventTextSource;
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
  if (error instanceof DepositCiteError) throw new DepositRefusedError(error.message, EXIT.DATAERR);
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

/** Answered or withdrawn; an undecodable name counts as open, so a strange file can only tighten a cap. */
function isClosed(present: ReadonlySet<string>, { asker, depositId }: FiledDeposit): boolean {
  if (asker === undefined || depositId === undefined) return false;
  try {
    const id = depositItemId(asker, depositId);
    return [...answerFileNames(id), withdrawnFileName(id)].some((name) => present.has(name));
  } catch {
    return false;
  }
}

/** Every deposit file with no answer or withdrawal beside it, under either the current or the legacy name. */
function openDeposits(names: readonly string[]): FiledDeposit[] {
  const present = new Set(names);
  return names
    .filter((name) => !name.startsWith(".") && name.endsWith(DEPOSIT_SUFFIX) && !name.endsWith(ANSWER_SUFFIX))
    .map(parseDepositName)
    .filter((filed) => !isClosed(present, filed));
}

/** The item ids of one asker's open deposits, so a refusal can name what to merge or withdraw. */
function openIdsOf(open: readonly FiledDeposit[], asker: string): string[] {
  const ids = open.filter((filed) => filed.asker === asker && filed.depositId !== undefined).map((filed) => depositItemId(asker, filed.depositId!));
  return [...new Set(ids)].sort();
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

function assertUnderAskerCap(open: readonly FiledDeposit[], asker: string): void {
  if (OWNER_ASKERS.has(asker)) return;
  const ids = openIdsOf(open, asker);
  if (ids.length < MAX_OPEN_DEPOSITS_PER_ASKER) return;
  throw new DepositRefusedError(
    `this asker already has ${MAX_OPEN_DEPOSITS_PER_ASKER} open deposits; merge or withdraw one ` +
      `(titan-console inbox withdraw <id> --reason ... --as <asker> --actor <seat>): ${ids.join(" ")}`,
    EXIT.TEMPFAIL,
  );
}

function assertUnderCaps(names: readonly string[], asker: string, maxOpenDeposits: number): void {
  const open = openDeposits(names);
  assertUnderAskerCap(open, asker);
  if (open.length >= maxOpenDeposits) {
    throw new DepositRefusedError(`the inbox already has ${maxOpenDeposits} open deposits`, EXIT.TEMPFAIL);
  }
}

/**
 * A repeat of a filed depositId returns its id even at a cap, since it adds nothing to the spool.
 * The repeat still goes through writeDeposit, which proves the file under that name is this deposit.
 */
async function fileOnce({ dir, maxOpenDeposits, events }: Required<InboxSource>, deposit: OwnerItemDeposit): Promise<DepositResult> {
  assertNameable(deposit);
  const id = depositItemId(deposit.asker, deposit.depositId);
  const names = await spoolNames(dir);
  const isRepeat = depositFileNames(deposit.asker, deposit.depositId).some((name) => names.includes(name));
  if (!isRepeat) assertUnderCaps(names, deposit.asker, maxOpenDeposits);
  const { created } = await writeDeposit(dir, deposit, { events });
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

export function inboxCommands({ dir, maxOpenDeposits = MAX_OPEN_DEPOSITS, events = readSessionEventText }: InboxSource) {
  const serialize = serializer();
  return {
    [INBOX_DEPOSIT]: depositCommand({
      name: INBOX_DEPOSIT,
      description: "File one owner item into the owner inbox; a repeat depositId returns the item id it already has",
      args: ownerItemDepositSchema,
      result: depositResult,
      run: (deposit: OwnerItemDeposit) => serialize(() => fileOnce({ dir, maxOpenDeposits, events }, deposit).catch(withoutSpoolPath)),
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
