/**
 * The small JSON files the console keeps beside a round or in its state dir: each written once with `wx`, and each read
 * without following a symlink and only up to the round size cap.
 */
import { open, type FileHandle } from "node:fs/promises";
import type { z } from "zod";
import { MAX_ROUND_BYTES, OPEN_FLAGS, readCapped } from "./rounds.js";

const errnoOf = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;

/** False when the file already exists; `wx` also refuses a symlink planted at the name. */
export async function writeJsonOnce(file: string, value: unknown): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (errnoOf(error) === "EEXIST") return false;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  return true;
}

export const exists = (file: string): Promise<boolean> =>
  open(file, OPEN_FLAGS).then(
    (handle) => handle.close().then(() => true),
    (error: unknown) => errnoOf(error) !== "ENOENT",
  );

export interface StateFile {
  bytes: Buffer;
  modifiedAt: Date;
}

/** Undefined when the file is missing, a symlink, not a regular file, or over the cap; never throws. */
export async function readStateFile(file: string): Promise<StateFile | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const stats = await handle.stat();
    const bytes = stats.isFile() ? await readCapped(handle, MAX_ROUND_BYTES) : null;
    return bytes === null ? undefined : { bytes, modifiedAt: stats.mtime };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Undefined for every way the file can be missing, not JSON, or not `schema`. */
export function parseStateJson<T>(file: StateFile | undefined, schema: z.ZodType<T>): T | undefined {
  if (file === undefined) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(file.bytes.toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export const readStateJson = async <T>(file: string, schema: z.ZodType<T>): Promise<T | undefined> => parseStateJson(await readStateFile(file), schema);
