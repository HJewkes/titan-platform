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

/**
 * Percent-encodes every UTF-8 byte outside [A-Za-z0-9_], so an untrusted value can never carry
 * a separator, a dot or a NUL into a file name, and two different values never share a name.
 */
function encodeNamePart(value: string): string {
  return Array.from(Buffer.from(value, "utf8"), (byte) => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9_]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

function checkedName(name: string): string {
  if (Buffer.byteLength(name) > MAX_FILE_NAME_BYTES) {
    throw new RangeError(`spool file name exceeds ${MAX_FILE_NAME_BYTES} bytes`);
  }
  return name;
}

/** The deposit's file name: `<asker>-<depositId>.json`, each part encoded so "-" stays a separator. */
export function depositFileName(asker: string, depositId: string): string {
  return checkedName(`${encodeNamePart(asker)}-${encodeNamePart(depositId)}${DEPOSIT_SUFFIX}`);
}

/** The answer's file name: `<id>.answer.json` beside the deposit, with the item id encoded. */
export function answerFileName(id: string): string {
  return checkedName(`${encodeNamePart(id)}${ANSWER_SUFFIX}`);
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

/**
 * Validates a deposit and files it once. A repeat of the same asker and depositId leaves the
 * first file in place and returns `created: false`. Throws on a refused or oversized deposit.
 */
export async function writeDeposit(dir: string, deposit: OwnerItemDeposit): Promise<WriteResult> {
  const parsed = ownerItemDepositSchema.parse(deposit);
  const body = JSON.stringify(parsed);
  if (Buffer.byteLength(body) > MAX_DEPOSIT_BYTES) {
    throw new RangeError(`deposit exceeds ${MAX_DEPOSIT_BYTES} bytes`);
  }
  return writeOnce(dir, depositFileName(parsed.asker, parsed.depositId), body);
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
  if (depositFileName(parsed.data.asker, parsed.data.depositId) !== name) {
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

/** Records the owner's answer to item `id` once; a second answer leaves the first in place. */
export async function writeAnswer(dir: string, id: string, answer: OwnerAnswer): Promise<WriteResult> {
  const parsed = answerSchema.parse(answer);
  return writeOnce(dir, answerFileName(id), JSON.stringify(parsed));
}

/** Returns the answer to item `id`, or undefined if none is filed. Throws on a malformed answer. */
export async function readAnswer(dir: string, id: string): Promise<OwnerAnswer | undefined> {
  try {
    return answerSchema.parse(JSON.parse(await readFile(join(dir, answerFileName(id)), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
