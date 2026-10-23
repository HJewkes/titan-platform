/**
 * Withdrawal: a seat takes back its own deposit without anyone answering it. A withdrawn deposit
 * has `<id>.withdrawn` beside it. Nothing here writes an answer file, and an answered deposit is
 * never withdrawn, so withdrawn stays its own status, apart from answered. Every withdraw and
 * restore appends one line to `withdrawals.jsonl` in the spool: who, when, why. Restore deletes
 * the marker; the log keeps both lines.
 *
 * `as` is self-declared, as a deposit's asker is: the check stops a seat closing another seat's
 * item by mistake, not a caller who can already write the spool. `actor` names who ran the verb,
 * which differs from the asker when a seat closes items a retired automation filed; marker and log
 * record both, `by` holding the asker as it always has.
 */
import { appendFile, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { OwnerItem } from "./schema.js";
import { readAnswer, readSpool, withdrawnFileName } from "./spool.js";

export const WITHDRAW_LOG = "withdrawals.jsonl";
/** `superseded:<id>` names the item that replaces this one. */
export const WITHDRAW_REASON = /^(obsolete|resolved|superseded:\S{1,200})$/;
const DEPOSIT_ID = /^deposit:/;

export const withdrawalSchema = z.strictObject({
  reason: z.string().regex(WITHDRAW_REASON),
  /** The deposit's asker. */
  by: z.string().min(1),
  /** Absent only on markers written before the actor was recorded. */
  actor: z.string().min(1).optional(),
  at: z.iso.datetime({ offset: true }),
});
export type Withdrawal = z.infer<typeof withdrawalSchema>;

/** `unknown`: no deposit has this id. `refused`: a bad reason, or the id is not a deposit, not this asker's, or answered. */
export class WithdrawRefusedError extends Error {
  constructor(
    message: string,
    readonly kind: "unknown" | "refused",
  ) {
    super(message);
    this.name = "WithdrawRefusedError";
  }
}

export interface WithdrawRequest {
  reason: string;
  /** Must equal the deposit's asker. */
  as: string;
  /** Who runs the withdraw; recorded beside the asker. */
  actor: string;
  now?: Date;
}
export interface RestoreRequest {
  as: string;
  actor: string;
  now?: Date;
}
export interface MatchRequest {
  asker: string;
  actor: string;
  /** A deposit matches when it carries any of these keys. */
  keys: readonly string[];
  reason: string;
  now?: Date;
  /** Lists the matches and writes nothing. */
  dryRun?: boolean;
}
export type WithdrawResult = { id: string; outcome: "withdrawn" | "already-withdrawn" };
export type RestoreResult = { id: string; outcome: "restored" | "not-withdrawn" };

const errno = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);
const refused = (message: string): WithdrawRefusedError => new WithdrawRefusedError(message, "refused");

/** The withdrawal of item `id`, or undefined when none is filed. Throws on a malformed marker. */
export async function readWithdrawal(dir: string, id: string): Promise<Withdrawal | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, withdrawnFileName(id)), "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
  return withdrawalSchema.parse(JSON.parse(text));
}

async function appendLog(dir: string, entry: Record<string, string>): Promise<void> {
  await appendFile(join(dir, WITHDRAW_LOG), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function requireActor(actor: string): void {
  if (actor.trim() === "") throw refused("an actor is required: name the seat running this");
}

async function ownDeposit(dir: string, id: string, as: string, actor: string): Promise<OwnerItem> {
  requireActor(actor);
  if (!DEPOSIT_ID.test(id)) throw refused(`${id} is not a deposit; only a seat's own deposits can be withdrawn`);
  const item = (await readSpool(dir)).items.find((each) => each.id === id);
  if (item === undefined) throw new WithdrawRefusedError(`no deposit ${id} in the spool`, "unknown");
  if (item.asker !== as) throw refused(`${id} was filed by ${item.asker ?? "no asker"}, not ${as}`);
  return item;
}

/** False when a marker is already there, so a second withdraw keeps the first reason. */
async function createMarker(dir: string, id: string, withdrawal: Withdrawal): Promise<boolean> {
  try {
    await writeFile(join(dir, withdrawnFileName(id)), `${JSON.stringify(withdrawal)}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (errno(error) === "EEXIST") return false;
    throw error;
  }
}

/** Withdraws the deposit `id` that `as` filed; throws WithdrawRefusedError on an unknown id or a refusal. */
export async function withdrawDeposit(dir: string, id: string, { reason, as, actor, now = new Date() }: WithdrawRequest): Promise<WithdrawResult> {
  if (!WITHDRAW_REASON.test(reason)) throw refused(`reason "${reason}" is not obsolete, resolved or superseded:<id>`);
  await ownDeposit(dir, id, as, actor);
  if ((await readAnswer(dir, id)) !== undefined) throw refused(`${id} is already answered; the owner's answer stands`);
  const withdrawal = { reason, by: as, actor, at: now.toISOString() };
  if (!(await createMarker(dir, id, withdrawal))) return { id, outcome: "already-withdrawn" };
  await appendLog(dir, { op: "withdraw", id, ...withdrawal });
  return { id, outcome: "withdrawn" };
}

/** Undoes a withdrawal of the deposit `id` that `as` filed, so it is open again. */
export async function restoreDeposit(dir: string, id: string, { as, actor, now = new Date() }: RestoreRequest): Promise<RestoreResult> {
  await ownDeposit(dir, id, as, actor);
  try {
    await unlink(join(dir, withdrawnFileName(id)));
  } catch (error) {
    if (errno(error) === "ENOENT") return { id, outcome: "not-withdrawn" };
    throw error;
  }
  await appendLog(dir, { op: "restore", id, by: as, actor, at: now.toISOString() });
  return { id, outcome: "restored" };
}

/** A deposit whose answer or marker cannot be read counts as closed, so a bulk withdraw skips it. */
async function isOpen(dir: string, id: string): Promise<boolean> {
  try {
    if ((await readAnswer(dir, id)) !== undefined) return false;
    await lstat(join(dir, withdrawnFileName(id)));
    return false;
  } catch (error) {
    return errno(error) === "ENOENT";
  }
}

/** Every open deposit `asker` filed with one of `keys`, each withdrawn with `reason` unless `dryRun`. */
export async function withdrawMatching(dir: string, { asker, actor, keys, reason, now = new Date(), dryRun = false }: MatchRequest): Promise<OwnerItem[]> {
  if (!WITHDRAW_REASON.test(reason)) throw refused(`reason "${reason}" is not obsolete, resolved or superseded:<id>`);
  requireActor(actor);
  const { items } = await readSpool(dir);
  const open: OwnerItem[] = [];
  for (const item of items) {
    if (item.asker === asker && item.keys.some((key) => keys.includes(key)) && (await isOpen(dir, item.id))) open.push(item);
  }
  if (!dryRun) for (const item of open) await withdrawDeposit(dir, item.id, { reason, as: asker, actor, now });
  return open;
}
