import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RefusedReason } from "../login.js";
import { readGatedFile } from "./gated-read.js";
import { CREDENTIALS_FILE, MAX_CREDENTIALS_BYTES } from "./login.js";
import { syncDir } from "./usage-file.js";

// Claude Code 2.1.x serializes its own refresh with two proper-lockfile locks, each a
// directory made with mkdir: this one in the config dir and a legacy one beside it. Its
// stale time is 60 s, and with no holder record of its own it never takes over a fresher lock.
export const REFRESH_LOCK = ".oauth_refresh.lock";
// Beside the lock, never inside it: Claude Code removes a stale lock with rmdir, which fails
// on a non-empty dir. It names which lock dirs this package made, and for which process.
export const REFRESH_LOCK_HOLDER = ".oauth_refresh.lock.anthropic-account";

export type CredentialsText =
  | { status: "text"; text: string }
  | { status: "missing" }
  | { status: "refused"; reason: RefusedReason };

export interface JsonFormat {
  indent: string | number | undefined;
  trailer: string;
}

const INDENTS: readonly (string | number | undefined)[] = [undefined, 2, 4, "\t"];

// Inode and ctime together, since a filesystem may hand a removed dir's inode to the next one.
interface DirIdentity {
  ino: number;
  ctimeMs: number;
}

interface HeldDir extends DirIdentity {
  dir: string;
}

interface HolderRecord {
  pid: number;
  primary: DirIdentity;
  legacy?: DirIdentity;
}

// The exact text that passed the gate, so a later read can be compared byte for byte.
// Unexpected filesystem errors are thrown unredacted; the caller drops them.
export function readCredentialsText(configDir: string, uid: number): CredentialsText {
  const file = path.join(configDir, CREDENTIALS_FILE);
  const read = readGatedFile(file, { maxBytes: MAX_CREDENTIALS_BYTES, ownerUid: uid });
  if (read.status === "missing") return read;
  if (read.status === "refused") {
    return { status: "refused", reason: read.reason === "too-large" ? "malformed" : read.reason };
  }
  try {
    return { status: "text", text: read.bytes.toString("utf8") };
  } finally {
    read.bytes.fill(0);
  }
}

export function unchangedSince(configDir: string, uid: number, expected: string): boolean {
  const now = readCredentialsText(configDir, uid);
  return now.status === "text" && now.text === expected;
}

// Only a layout JSON.stringify reproduces exactly is rewritten, which is what keeps every
// field the refresh does not touch byte-identical.
export function jsonFormatOf(text: string, parsed: unknown): JsonFormat | null {
  const body = text.trimEnd();
  const index = INDENTS.findIndex((indent) => JSON.stringify(parsed, null, indent) === body);
  return index === -1 ? null : { indent: INDENTS[index], trailer: text.slice(body.length) };
}

function makeLockDir(dir: string): HeldDir | null {
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  const { ino, ctimeMs } = fs.lstatSync(dir);
  return { dir, ino, ctimeMs };
}

// A lock another process took over as stale is not this call's to remove.
function removeLockDir(held: HeldDir): void {
  try {
    const now = fs.lstatSync(held.dir);
    if (now.ino === held.ino && now.ctimeMs === held.ctimeMs) fs.rmdirSync(held.dir);
  } catch {
    return;
  }
}

function legacyLockPath(configDir: string): string {
  try {
    return `${fs.realpathSync(configDir)}.lock`;
  } catch {
    return `${configDir}.lock`;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const identitySchema = z.object({ ino: z.number(), ctimeMs: z.number() });
const holderSchema = z.object({ pid: z.number().int().positive(), primary: identitySchema, legacy: identitySchema.optional() });

function readHolder(configDir: string): HolderRecord | null {
  try {
    const parsed = holderSchema.safeParse(JSON.parse(fs.readFileSync(path.join(configDir, REFRESH_LOCK_HOLDER), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Only lock dirs the record names are removed, and only once the process that
// made them has exited: a lock with no record, or another inode, is Claude Code's.
function reclaimAbandoned(configDir: string, lockDir: string, legacyDir: string): void {
  const holder = readHolder(configDir);
  if (holder === null || isAlive(holder.pid)) return;
  if (holder.legacy !== undefined) removeLockDir({ dir: legacyDir, ...holder.legacy });
  removeLockDir({ dir: lockDir, ...holder.primary });
  fs.rmSync(path.join(configDir, REFRESH_LOCK_HOLDER), { force: true });
}

const identityOf = ({ ino, ctimeMs }: HeldDir): DirIdentity => ({ ino, ctimeMs });

function recordHolder(configDir: string, primary: HeldDir, legacy: HeldDir | undefined): void {
  const record: HolderRecord = { pid: process.pid, primary: identityOf(primary), legacy: legacy && identityOf(legacy) };
  fs.writeFileSync(path.join(configDir, REFRESH_LOCK_HOLDER), JSON.stringify(record), { mode: 0o600 });
}

function releaseLocks(configDir: string, primary: HeldDir, legacy: HeldDir | undefined): void {
  fs.rmSync(path.join(configDir, REFRESH_LOCK_HOLDER), { force: true });
  if (legacy !== undefined) removeLockDir(legacy);
  removeLockDir(primary);
}

function takeLocks(configDir: string, lockDir: string, legacyDir: string): (() => void) | null {
  const primary = makeLockDir(lockDir);
  if (primary === null) return null;
  let legacy: HeldDir | null | undefined;
  try {
    legacy = makeLockDir(legacyDir);
  } catch {
    legacy = undefined;
  }
  if (legacy === null) {
    removeLockDir(primary);
    return null;
  }
  try {
    recordHolder(configDir, primary, legacy);
  } catch (error) {
    releaseLocks(configDir, primary, legacy);
    throw error;
  }
  return () => releaseLocks(configDir, primary, legacy);
}

// Takes both of Claude Code's refresh locks, in its order, or neither. A lock already held
// is never stolen, however old: Claude Code's own stale takeover handles a dead holder.
// The one exception is a lock this package made and a crash left behind. Like Claude Code,
// an unusable legacy path (not a held one) is skipped.
export function acquireRefreshLock(configDir: string): (() => void) | null {
  const lockDir = path.join(configDir, REFRESH_LOCK);
  const legacyDir = legacyLockPath(configDir);
  const taken = takeLocks(configDir, lockDir, legacyDir);
  if (taken !== null) return taken;
  reclaimAbandoned(configDir, lockDir, legacyDir);
  return takeLocks(configDir, lockDir, legacyDir);
}

function writeSynced(file: string, text: string): void {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Writes `next` to a temp file in the same dir, then renames it over the credentials file
// only if the file still holds `expected`: a reader sees the old file or the new one, never
// a partial one, and a file another writer changed is left as that writer left it.
export function replaceCredentials(configDir: string, uid: number, expected: string, next: string): "written" | "changed" {
  const temp = path.join(configDir, `.${CREDENTIALS_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let renamed = false;
  try {
    writeSynced(temp, next);
    if (!unchangedSince(configDir, uid, expected)) return "changed";
    fs.renameSync(temp, path.join(configDir, CREDENTIALS_FILE));
    renamed = true;
  } finally {
    if (!renamed) fs.rmSync(temp, { force: true });
  }
  syncDir(configDir);
  return "written";
}
