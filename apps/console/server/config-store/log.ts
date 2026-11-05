/**
 * The coordinator document's revision log (TP-3579 M3): one `titan-coordinator-revision/v1` JSON
 * line per revision in `<console state>/config/coordinator.revisions.jsonl`, the path tool-guard
 * keeps agents from writing (X1). History is never rewritten: a revision is only ever appended,
 * and only after the whole chain, the new entry included, passes `verifyChain`.
 *
 * Reads fail closed. A torn last line, a line that is not JSON or a broken chain makes the log
 * `invalid`, and nothing is appended to an invalid log. Every rev 0 write, into an absent log or
 * a zero-byte one, first takes an O_EXCL sibling claim held until the line is synced, so two
 * imports cannot both write it; O_EXCL on the log alone cannot cover a zero-byte file that
 * already exists. A later append refuses when the file grew after it was read.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { revisionSha, verifyChain, type ChainError, type ConfigRevision } from "@titan-design/coordinator";
import { syncDirectory } from "./materialize.js";

const CONFIG_DIR = "config";
const REVISIONS_FILE = "coordinator.revisions.jsonl";
const REV0_CLAIM_SUFFIX = ".rev0-claim";
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW;

type LogState =
  | { state: "empty"; exists: boolean }
  | { state: "verified"; revisions: unknown[]; head: ConfigRevision; bytes: number }
  | { state: "invalid"; errors: ChainError[] };

type NewRevision = Omit<ConfigRevision, "$schema" | "rev" | "parent">;

export function revisionLogPath(stateDir: string): string {
  return path.join(stateDir, CONFIG_DIR, REVISIONS_FILE);
}

export class RevisionLogError extends Error {}

const invalid = (rev: number, message: string): LogState => ({ state: "invalid", errors: [{ rev, code: "invalid", message }] });
const errnoOf = (error: unknown): unknown => (error instanceof Error && "code" in error ? error.code : undefined);

function parseLines(text: string): unknown[] | LogState {
  const lines = text.split("\n");
  if (lines.pop() !== "") return invalid(lines.length, "the last line is incomplete");
  const revisions: unknown[] = [];
  for (const [index, line] of lines.entries()) {
    try {
      revisions.push(JSON.parse(line));
    } catch {
      return invalid(index, "the line is not JSON");
    }
  }
  return revisions;
}

/** The log as it stands; never throws for a bad log, only for an unreadable one. */
export async function readRevisionLog(file: string): Promise<LogState> {
  const stats = await lstat(file).catch((error: unknown) => (errnoOf(error) === "ENOENT" ? null : Promise.reject(error)));
  if (stats === null) return { state: "empty", exists: false };
  if (!stats.isFile()) return invalid(0, "the log is not a regular file");
  if (stats.size > MAX_LOG_BYTES) return invalid(0, `the log is over ${MAX_LOG_BYTES} bytes`);
  const text = await readFile(file, "utf8");
  if (text === "") return { state: "empty", exists: true };
  const revisions = parseLines(text);
  if (!Array.isArray(revisions)) return revisions;
  const chain = verifyChain(revisions);
  return chain.ok ? { state: "verified", revisions, head: chain.head, bytes: Buffer.byteLength(text) } : { state: "invalid", errors: chain.errors };
}

function nextRevision(log: LogState, next: NewRevision): { revision: ConfigRevision; chain: unknown[] } {
  if (log.state === "invalid") throw new RevisionLogError(`the log is invalid; nothing is appended to it: ${log.errors.map((e) => `rev ${e.rev}: ${e.message}`).join("; ")}`);
  const revisions = log.state === "verified" ? log.revisions : [];
  const last = revisions.at(-1);
  const revision: ConfigRevision = { $schema: "titan-coordinator-revision/v1", rev: revisions.length, parent: last === undefined ? null : revisionSha(last), ...next };
  return { revision, chain: [...revisions, revision] };
}

/** The checks run on the opened file, so a swap after open cannot redirect the write. */
async function assertPrivate(handle: FileHandle, expectedBytes: number): Promise<void> {
  const stats = await handle.stat();
  const uid = process.getuid?.();
  if (!stats.isFile() || (uid !== undefined && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
    throw new RevisionLogError("the revision log is not a private regular file owned by this user");
  }
  if (stats.size !== expectedBytes) throw new RevisionLogError("the revision log changed after it was read; read it again");
}

async function openForWrite(file: string, log: LogState): Promise<FileHandle> {
  const creating = log.state === "empty" && !log.exists;
  return open(file, creating ? CREATE_FLAGS : APPEND_FLAGS, 0o600).catch((error: unknown) => {
    throw errnoOf(error) === "EEXIST" ? new RevisionLogError("another writer created rev 0 first; read the log again") : error;
  });
}

async function writeOpened(file: string, line: string, log: LogState): Promise<void> {
  const handle = await openForWrite(file, log);
  try {
    await assertPrivate(handle, log.state === "verified" ? log.bytes : 0);
    await handle.write(line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Held across the open, the size check and the write, so two writers cannot both write rev 0. */
async function claimRev0(file: string): Promise<() => Promise<void>> {
  const claim = `${file}${REV0_CLAIM_SUFFIX}`;
  const handle = await open(claim, CREATE_FLAGS, 0o600).catch((error: unknown) => {
    throw errnoOf(error) === "EEXIST"
      ? new RevisionLogError(`another writer is writing rev 0 into ${file} (claim ${claim}); read the log again, or remove the claim if no import is running`)
      : error;
  });
  await handle.close();
  return () => unlink(claim);
}

async function writeLine(file: string, line: string, log: LogState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const release = log.state === "empty" ? await claimRev0(file) : null;
  try {
    await writeOpened(file, line, log);
  } finally {
    await release?.();
  }
  if (log.state === "empty") await syncDirectory(path.dirname(file));
}

/** Appends the next revision, numbered and parented from the log's head, and returns it. */
export async function appendRevision(file: string, next: NewRevision): Promise<ConfigRevision> {
  const log = await readRevisionLog(file);
  const { revision, chain } = nextRevision(log, next);
  const checked = verifyChain(chain);
  if (!checked.ok) throw new RevisionLogError(`the new revision is refused: ${checked.errors.map((e) => e.message).join("; ")}`);
  await writeLine(file, `${JSON.stringify(revision)}\n`, log);
  return revision;
}
