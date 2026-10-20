/**
 * Writes the revision log head's document where readers load it (TP-3579 M3):
 * `<app-paths config dir of titan-coordinator>/coordinator.json`. The bytes go to a temp file in
 * the same directory, are fsynced, and then renamed over the target, so a crash mid-write leaves
 * the previous document whole; the directory is fsynced so the rename itself survives a crash.
 * Readers compare the file's `documentSha` with the log head, so its formatting carries no meaning.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { appDirs, type PathOptions } from "@titan-design/app-paths";
import { documentSha, type CoordinatorConfig } from "@titan-design/coordinator";

const COORDINATOR_APP = "titan-coordinator";
const COORDINATOR_FILE = "coordinator.json";

export type WriteBytes = (handle: FileHandle, bytes: Buffer) => Promise<void>;
type MaterializedState = "current" | "stale" | "missing" | "unreadable";

interface MaterializeOptions {
  /** A seam for the crash test; the default writes every byte. */
  writeBytes?: WriteBytes;
}

const writeAll: WriteBytes = async (handle, bytes) => {
  await handle.write(bytes);
};

export function coordinatorFilePath(opts: PathOptions = {}): string {
  return path.join(appDirs(COORDINATOR_APP, opts).config, COORDINATOR_FILE);
}

export async function syncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeTemp(file: string, bytes: Buffer, writeBytes: WriteBytes): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    await writeBytes(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Replaces `file` with `document` by temp file, fsync and rename; returns the document's sha. */
export async function materializeDocument(file: string, document: CoordinatorConfig, { writeBytes = writeAll }: MaterializeOptions = {}): Promise<{ sha: string }> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeTemp(temp, Buffer.from(`${JSON.stringify(document, null, 2)}\n`), writeBytes);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await syncDirectory(dir);
  return { sha: documentSha(document) };
}

/** Whether the materialized file holds the document whose sha is `expectedSha`. */
export async function readMaterialized(file: string, expectedSha: string): Promise<MaterializedState> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    return documentSha(JSON.parse(text)) === expectedSha ? "current" : "stale";
  } catch {
    return "unreadable";
  }
}
