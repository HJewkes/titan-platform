import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fromDeposit, ownerItemDepositSchema, type OwnerItemDeposit } from "./deposit.js";
import { ownerItemSchema, type OwnerAnswer, type OwnerItem } from "./schema.js";

/** The cap on one deposit file, so a runaway context cannot fill the spool or the console. */
export const MAX_DEPOSIT_BYTES = 64 * 1024;

const MAX_FILE_NAME_BYTES = 255;
const DEPOSIT_SUFFIX = ".json";
const ANSWER_SUFFIX = ".answer.json";
const answerSchema = ownerItemSchema.shape.answer.unwrap();

export type WriteResult = { file: string; created: boolean };
export type SpoolReject = { file: string; reason: string };
export type SpoolContents = { items: OwnerItem[]; rejects: SpoolReject[] };

/** In a `u` regex a surrogate pair is one code point, so this matches only a lone surrogate. */
const LONE_SURROGATE = /\p{Surrogate}/u;
const KEPT = /[a-z0-9_]/;
const LEGACY_KEPT = /[A-Za-z0-9_]/;

/** Thrown when a spool name is already held by a different deposit, rather than claim it was filed. */
export class SpoolNameCollisionError extends Error {
  constructor(readonly file: string) {
    super("the spool file name is already held by a different deposit");
    this.name = "SpoolNameCollisionError";
  }
}

/**
 * Percent-encodes every UTF-8 byte outside [a-z0-9_], so an untrusted value can never carry a
 * separator, a dot or a NUL into a file name, and two different values never share a name, even
 * on a case-insensitive filesystem. A lone surrogate is refused: UTF-8 would turn it into U+FFFD
 * and give it the name of a value that really holds U+FFFD.
 */
function encodeNamePart(value: string, kept: RegExp = KEPT): string {
  if (LONE_SURROGATE.test(value)) throw new RangeError("spool file name part is not well-formed Unicode");
  return Array.from(Buffer.from(value, "utf8"), (byte) => {
    const char = String.fromCharCode(byte);
    return kept.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

function checkedName(name: string): string {
  if (Buffer.byteLength(name) > MAX_FILE_NAME_BYTES) {
    throw new RangeError(`spool file name exceeds ${MAX_FILE_NAME_BYTES} bytes`);
  }
  return name;
}

function rawDepositName(asker: string, depositId: string, kept: RegExp = KEPT): string {
  return `${encodeNamePart(asker, kept)}-${encodeNamePart(depositId, kept)}${DEPOSIT_SUFFIX}`;
}

function rawAnswerName(id: string, kept: RegExp = KEPT): string {
  return `${encodeNamePart(id, kept)}${ANSWER_SUFFIX}`;
}

/** The deposit's file name: `<asker>-<depositId>.json`, each part encoded so "-" stays a separator. */
export function depositFileName(asker: string, depositId: string): string {
  return checkedName(rawDepositName(asker, depositId));
}

/** The answer's file name: `<id>.answer.json` beside the deposit, with the item id encoded. */
export function answerFileName(id: string): string {
  return checkedName(rawAnswerName(id));
}

/**
 * Every name this deposit may already be filed under: the current name, then the name a spool
 * written before A-Z was escaped gave it, when that differs. Readers accept both; writers only
 * ever create the current one.
 */
export function depositFileNames(asker: string, depositId: string): string[] {
  return fittingNames(rawDepositName(asker, depositId), rawDepositName(asker, depositId, LEGACY_KEPT));
}

/** Every name an answer to `id` may already be filed under, current name first. */
export function answerFileNames(id: string): string[] {
  return fittingNames(rawAnswerName(id), rawAnswerName(id, LEGACY_KEPT));
}

function fittingNames(current: string, legacy: string): string[] {
  return [...new Set([current, legacy])].filter((name) => Buffer.byteLength(name) <= MAX_FILE_NAME_BYTES);
}

/**
 * Writes to a temp file, then hard-links it into place. Unlike rename, link refuses to replace
 * an existing file, so the first writer of a name wins and a racing retry cannot clobber it.
 */
async function writeOnce(dir: string, name: string, body: string): Promise<WriteResult> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  const temp = join(dir, `.${name}.${randomUUID()}.tmp`);
  await writeFile(temp, body, { mode: 0o600, flag: "wx" });
  try {
    await link(temp, file);
    return { file, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { file, created: false };
    throw error;
  } finally {
    await unlink(temp);
  }
}

/** The first of `names` present in `dir`, so a legacy-named file still counts as filed. */
async function firstPresent(dir: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) {
    try {
      await lstat(join(dir, name));
      return join(dir, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

/**
 * A name already taken must hold this very deposit. A case-folding filesystem, or a file planted
 * under the name, would otherwise make `created: false` report an id that was never filed.
 */
async function assertHeldBy(file: string, deposit: { asker: string; depositId: string }): Promise<void> {
  let held: unknown;
  try {
    held = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new SpoolNameCollisionError(file);
  }
  const parsed = ownerItemDepositSchema.safeParse(held);
  if (!parsed.success || parsed.data.asker !== deposit.asker || parsed.data.depositId !== deposit.depositId) {
    throw new SpoolNameCollisionError(file);
  }
}

/**
 * Validates a deposit and files it once. A repeat of the same asker and depositId, under its
 * current or its legacy name, leaves the first file in place and returns `created: false`.
 * Throws on a refused or oversized deposit, and on a name held by a different deposit.
 */
export async function writeDeposit(dir: string, deposit: OwnerItemDeposit): Promise<WriteResult> {
  const parsed = ownerItemDepositSchema.parse(deposit);
  const body = JSON.stringify(parsed);
  if (Buffer.byteLength(body) > MAX_DEPOSIT_BYTES) {
    throw new RangeError(`deposit exceeds ${MAX_DEPOSIT_BYTES} bytes`);
  }
  const name = depositFileName(parsed.asker, parsed.depositId);
  const legacy = depositFileNames(parsed.asker, parsed.depositId).filter((each) => each !== name);
  const filedEarlier = await firstPresent(dir, legacy);
  const result = filedEarlier ? { file: filedEarlier, created: false } : await writeOnce(dir, name, body);
  if (!result.created) await assertHeldBy(result.file, parsed);
  return result;
}

function isDepositFile(name: string): boolean {
  return !name.startsWith(".") && name.endsWith(DEPOSIT_SUFFIX) && !name.endsWith(ANSWER_SUFFIX);
}

/** Reasons never quote file contents, so a planted file cannot leak through the rejects list. */
async function readDepositFile(dir: string, name: string): Promise<OwnerItem | string> {
  const path = join(dir, name);
  const stats = await lstat(path);
  if (!stats.isFile()) return "not a regular file";
  if (stats.size > MAX_DEPOSIT_BYTES) return `larger than ${MAX_DEPOSIT_BYTES} bytes`;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return "not valid JSON";
  }
  const parsed = ownerItemDepositSchema.safeParse(raw);
  if (!parsed.success) return z.prettifyError(parsed.error);
  if (!depositFileNames(parsed.data.asker, parsed.data.depositId).includes(name)) {
    return "file name does not match its asker and depositId";
  }
  return fromDeposit(parsed.data, stats.mtime);
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Reads every deposit in the spool as an open OwnerItem, opened at the file's mtime. A bad
 * file lands in `rejects` and never stops the rest; a missing spool reads as empty.
 */
export async function readSpool(dir: string): Promise<SpoolContents> {
  const contents: SpoolContents = { items: [], rejects: [] };
  for (const name of (await listNames(dir)).filter(isDepositFile)) {
    try {
      const result = await readDepositFile(dir, name);
      if (typeof result === "string") contents.rejects.push({ file: name, reason: result });
      else contents.items.push(result);
    } catch (error) {
      const { code, message } = error as NodeJS.ErrnoException;
      contents.rejects.push({ file: name, reason: code ?? message });
    }
  }
  return contents;
}

/** Records the owner's answer to item `id` once; a second answer, under either name, leaves the first in place. */
export async function writeAnswer(dir: string, id: string, answer: OwnerAnswer): Promise<WriteResult> {
  const parsed = answerSchema.parse(answer);
  const name = answerFileName(id);
  const filedEarlier = await firstPresent(dir, answerFileNames(id).filter((each) => each !== name));
  if (filedEarlier) return { file: filedEarlier, created: false };
  return writeOnce(dir, name, JSON.stringify(parsed));
}

/** Returns the answer to item `id`, or undefined if none is filed. Throws on a malformed answer. */
export async function readAnswer(dir: string, id: string): Promise<OwnerAnswer | undefined> {
  const file = await firstPresent(dir, answerFileNames(id));
  if (!file) return undefined;
  try {
    return answerSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
